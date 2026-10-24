import "../styles.css";
import { QueryClient } from "@tanstack/react-query";
import type { ZodType } from "zod";
import type { ActionRequest, ActionResponse } from "./index";
export { SafeAreaTopScrim } from "./client/safe-area";
export type { SafeAreaTopScrimProps, SafeAreaTopScrimVariant, } from "./client/safe-area";
export { bytesToBase64, fileToBase64 } from "./client/file-encoding";
/**
 * Error thrown by a {@link createActionClient} call when the daemon returns a
 * non-OK HTTP response. Carries the HTTP `status` so retry policy can tell a
 * permanent client error (4xx) apart from retryable backpressure/transient
 * failures, and the server's `Retry-After` (when present) as `retryAfterMs` so
 * the backoff honors it.
 */
export declare class SpaceActionError extends Error {
    readonly status: number;
    readonly retryAfterMs?: number | undefined;
    readonly retrySafe: boolean;
    constructor(message: string, status: number, retryAfterMs?: number | undefined, retrySafe?: boolean);
}
export declare const PERMANENT_ACTION_STATUSES: Set<number>;
/** Retries after the first failure for a retryable action error. */
export declare const MAX_ACTION_RETRIES = 3;
/**
 * Default retry predicate for Space action queries, used by
 * {@link spaceQueryClient}. Retry only explicit pre-invocation failures, with
 * bounded backoff. Per-query overrides must preserve this outcome boundary.
 */
export declare function shouldRetryAction(failureCount: number, error: unknown): boolean;
/**
 * Retry delay for Space action queries: exponential backoff with full jitter,
 * honoring the server's `Retry-After` (carried on {@link SpaceActionError}) as
 * a floor. Full jitter de-synchronizes clients so a recovering worker pool is
 * not hit by a synchronized retry herd. `failureCount` is the number of prior
 * failures (0 before the first retry).
 */
export declare function actionRetryDelay(failureCount: number, error: unknown): number;
/**
 * Shared TanStack Query client for every Muse Space.
 *
 * This singleton is the only way a space should obtain a `QueryClient`. The
 * build pipeline's client validator forbids local `new QueryClient(...)`
 * construction so defaults (cache lifetime, retry policy, refetch behavior)
 * stay tunable here in one place across the entire fleet. The defaults below
 * are deliberately conservative: stock TanStack defaults (retry: 3,
 * staleTime: 0, refetchOnWindowFocus: true) let a saturated worker pool turn
 * one overloaded Space client into a fleet-visible retry storm.
 *
 *   import { spaceQueryClient } from "@hatch/space-sdk/client";
 *   import { QueryClientProvider } from "@tanstack/react-query";
 *
 *   <QueryClientProvider client={spaceQueryClient}>
 *     <App />
 *   </QueryClientProvider>
 */
export declare const spaceQueryClient: QueryClient;
export declare function installAuditSettleProbe(queryClient?: QueryClient): void;
export declare function installSpaceQueryInvalidationListener(queryClient?: QueryClient): void;
/**
 * Request shape for an action on a typed action client, by name.
 *
 *     import { api } from "./api";
 *     import type { ApiRequest } from "@hatch/space-sdk/client";
 *     type Filter = ApiRequest<typeof api, "listArticles">;
 */
export type ApiRequest<C extends Record<string, (args: never) => Promise<unknown>>, K extends keyof C> = Parameters<C[K]>[0];
/**
 * Response shape for an action on a typed action client, by name.
 *
 *     import { api } from "./api";
 *     import type { ApiResponse } from "@hatch/space-sdk/client";
 *     type Article = ApiResponse<typeof api, "listArticles">["articles"][number];
 */
export type ApiResponse<C extends Record<string, (args: never) => Promise<unknown>>, K extends keyof C> = Awaited<ReturnType<C[K]>>;
type ClientActionShape = {
    request: ZodType;
    response: ZodType;
};
export type ActionClient<A extends Record<string, ClientActionShape>> = {
    [K in keyof A]: (args: ActionRequest<A[K]>) => Promise<ActionResponse<A[K]>>;
};
interface ClientOptions {
    /** Override the action endpoint (defaults to `./actions` resolved against `location.href`). */
    endpoint?: string;
    /** Inject a custom fetch (mostly for tests). */
    fetch?: typeof globalThis.fetch;
}
export declare function createActionClient<A extends Record<string, ClientActionShape>>(options?: ClientOptions): ActionClient<A>;
//# sourceMappingURL=client.d.ts.map