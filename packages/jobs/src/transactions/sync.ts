/**
 * Transactions Sync Job
 *
 * This job synchronizes bank account transactions for a given team. It performs the following steps:
 *
 * 1. Fetch enabled bank accounts for the team
 * 2. For each account:
 *    a. Fetch and update account balance
 *    b. Fetch and format transactions
 *    c. Handle any errors that occur during the process
 * 3. Process results:
 *    a. Update failed accounts
 *    b. Update bank connection statuses
 *    c. Upsert successful transactions
 *    d. Send notifications for new transactions
 * 4. Revalidate relevant cache tags
 *
 * The job uses error handling and retries to manage connection issues,
 * and updates the status of bank connections based on success or failure.
 */

import Midday from "@midday-ai/engine";
import { revalidateTag } from "next/cache";
import { client, supabase } from "../client";
import { Events, Jobs } from "../constants";
import { engine } from "../utils/engine";
import { parseAPIError } from "../utils/error";
import { getClassification, transformTransaction } from "../utils/transform";
import { scheduler } from "./scheduler";

client.defineJob({
  id: Jobs.TRANSACTIONS_SYNC,
  name: "Transactions - Sync",
  version: "0.0.2",
  trigger: scheduler,
  integrations: { supabase },
  run: async (_, io, ctx) => {
    const supabase = io.supabase.client;

    const teamId = ctx.source?.id as string;

    // Fetch enabled bank accounts for the team
    const { data: accountsData, error: accountsError } = await supabase
      .from("bank_accounts")
      .select(
        "id, team_id, account_id, type, bank_connection:bank_connection_id(id, provider, access_token, status, error_retries)",
      )
      .eq("team_id", teamId)
      .eq("enabled", true)
      .lt("bank_connection.error_retries", 4)
      .eq("manual", false);

    if (accountsError) {
      await io.logger.error("Accounts Error", accountsError);
      return;
    }

    const connectionMap = new Map();

    // Process each account
    const promises = accountsData?.map(async (account) => {
      try {
        await io.logger.info(`Processing account ${account.id}`);

        // Fetch and update account balance
        const balance = await engine.accounts.balance({
          provider: account.bank_connection.provider,
          id: account.account_id,
          accessToken: account.bank_connection?.access_token,
        });

        if (balance.data?.amount && balance.data.amount > 0) {
          await io.supabase.client
            .from("bank_accounts")
            .update({
              balance: balance.data.amount,
              error_details: null,
            })
            .eq("id", account.id);

          await io.logger.info(`Updated balance for account ${account.id}`);
        }

        // Fetch and format transactions
        const transactions = await engine.transactions.list({
          provider: account.bank_connection.provider,
          accountId: account.account_id,
          accountType: getClassification(account.type),
          accessToken: account.bank_connection?.access_token,
          latest: "true",
        });

        const formattedTransactions = transactions.data?.map((transaction) => {
          return transformTransaction({
            transaction,
            teamId: account.team_id,
            bankAccountId: account.id,
          });
        });

        await io.logger.info(
          `Fetched ${formattedTransactions?.length || 0} transactions for account ${account.id}`,
        );

        // Mark connection as successful
        connectionMap.set(account.bank_connection.id, {
          success: true,
          errorRetries: 0,
          status: "connected",
        });

        return {
          success: true,
          transactions: formattedTransactions,
          accountId: account.id,
        };
      } catch (error) {
        // Handle errors and update connection status
        let errorDetails = "Unknown error occurred";
        let errorCode = "unknown";

        if (error instanceof Midday.APIError) {
          const parsedError = parseAPIError(error);
          errorDetails = parsedError.message;
          errorCode = parsedError.code;
        } else if (error instanceof Error) {
          errorDetails = error.message;
        }

        await io.logger.error(`Error processing account ${account.id}`, {
          error: errorDetails,
          errorCode,
        });

        connectionMap.set(account.bank_connection.id, {
          success: false,
          status: errorCode,
        });

        return {
          success: false,
          accountId: account.id,
          error: errorDetails,
          errorCode,
        };
      }
    });

    try {
      if (promises) {
        const results = await Promise.all(promises);

        const successfulResults = results.filter((result) => result.success);
        const failedResults = results.filter((result) => !result.success);

        await io.logger.info(
          `Sync results: ${successfulResults.length} successful, ${failedResults.length} failed`,
        );

        if (failedResults.length > 0) {
          await io.logger.error("Some accounts failed to sync", failedResults);

          // Update failed accounts
          for (const failedResult of failedResults) {
            await supabase
              .from("bank_accounts")
              .update({
                // enabled: false, // TODO: Disable if the account id is not found in the bank connection
                error_details: failedResult.error,
              })
              .eq("id", failedResult.accountId);
          }
        }

        // Update bank connections status
        for (const [connectionId, connectionStatus] of connectionMap) {
          let updateData: {
            last_accessed?: string;
            status: string;
            error_details?: string | null;
            error_retries?: number;
          };

          if (successfulResults.length > 0) {
            // At least one account succeeded
            updateData = {
              last_accessed: new Date().toISOString(),
              status: "connected",
              error_details: null,
              error_retries: 0,
            };
          } else {
            // All accounts failed
            const { data } = await supabase
              .from("bank_connections")
              .select("error_retries")
              .eq("id", connectionId)
              .single();

            const currentErrorRetries = data?.error_retries || 0;
            const newErrorRetries = currentErrorRetries + 1;

            updateData = {
              last_accessed: new Date().toISOString(),
              status: connectionStatus.status,
              error_details: connectionStatus.errorDetails,
            };

            if (connectionStatus.status !== "unknown") {
              updateData.error_retries = newErrorRetries;
            }
          }

          await supabase
            .from("bank_connections")
            .update(updateData)
            .eq("id", connectionId);

          await io.logger.info(
            `Updated bank connection ${connectionId} status to ${updateData.status}`,
          );
        }

        // Process successful transactions
        const transactions = successfulResults.flatMap(
          (result) => result.transactions,
        );

        if (transactions && transactions.length > 0) {
          await io.logger.info(`Upserting ${transactions.length} transactions`);

          const { error: transactionsError, data: transactionsData } =
            await supabase
              .from("transactions")
              .upsert(transactions, {
                onConflict: "internal_id",
                ignoreDuplicates: true,
              })
              .select("*");

          if (transactionsError) {
            await io.logger.error("Transactions error", transactionsError);
          }

          // Send notifications for new transactions
          if (transactionsData && transactionsData.length > 0) {
            await io.sendEvent("🔔 Send notifications", {
              name: Events.TRANSACTIONS_NOTIFICATION,
              payload: {
                teamId,
                transactions: transactionsData.map((transaction) => ({
                  id: transaction.id,
                  date: transaction.date,
                  amount: transaction.amount,
                  name: transaction.name,
                  currency: transaction.currency,
                  category: transaction.category_slug,
                  status: transaction.status,
                })),
              },
            });

            revalidateTag(`transactions_${teamId}`);
            revalidateTag(`spending_${teamId}`);
            revalidateTag(`metrics_${teamId}`);
            revalidateTag(`expenses_${teamId}`);
          }
        }

        revalidateTag(`bank_accounts_${teamId}`);
        revalidateTag(`bank_connections_${teamId}`);
      }
    } catch (error) {
      await io.logger.error("Unexpected error during transaction sync", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
