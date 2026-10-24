// Server-side surface of @hatch/space-sdk.
//
// Imported as `@hatch/space-sdk` from a space's `server/src/actions.ts`:
//
//   import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
//
//   export const Actions = {
//     listEntries: defineAction({
//       request: z.object({ limit: z.number() }),
//       response: z.object({ entries: z.array(z.string()) }),
//       async handler(ctx, args) { … },
//     }),
//   } satisfies ActionsModule;
//
// The browser-side counterpart lives at @hatch/space-sdk/client.
import { createDefineAction, createPrivilegedExecutor, definePrivilegedContracts, definePrivilegedHandlers, isAction as isSharedAction, isPrivilegedContract, isPrivilegedHandlers, z, } from "./server-contract";
export { ACTION_BRAND, PRIVILEGED_CONTRACT_BRAND, PRIVILEGED_HANDLERS_FORMAT, z, } from "./server-contract";
// Local handle for the `Ctx` interface below; the full set of these symbols
// is re-exported from `./verticals` further down.
import {} from "./verticals";
export { createPrivilegedExecutor, definePrivilegedContracts, definePrivilegedHandlers, isPrivilegedContract, isPrivilegedHandlers, };
/**
 * Brand string carried on every `InferenceSchemaError` instance. Same
 * pattern as `ACTION_BRAND`: bundle-stable string identity, so cross-bundle
 * recognition via `InferenceSchemaError.is(e)` works even when the worker
 * and the user's `actions.js` were bundled with separate copies of the SDK
 * (which is the normal case — each `bun build` inlines the SDK into its own
 * output).
 */
export const INFERENCE_SCHEMA_ERROR_BRAND = "@hatch/space-sdk/InferenceSchemaError/v1";
/**
 * Thrown when the model's structured response does not satisfy the Zod
 * schema passed to `complete()`. Inspect `issues` for the per-path
 * validation failures.
 *
 * **Use `InferenceSchemaError.is(e)` for the catch check, not
 * `e instanceof InferenceSchemaError`.** The worker that throws this error
 * and the user `actions.js` that catches it are separate bundles with
 * separate class identities; `instanceof` would return `false` even when the
 * error did come from a failed schema validation. `is()` does an
 * `instanceof` first (same-bundle fast path) then falls back to a stable
 * brand string check.
 */
export class InferenceSchemaError extends Error {
    /** @internal — branded property; check via `InferenceSchemaError.is(e)`. */
    __brand = INFERENCE_SCHEMA_ERROR_BRAND;
    issues;
    constructor(issues) {
        super(`Inference output failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
        this.name = "InferenceSchemaError";
        this.issues = issues;
    }
    /**
     * Type guard that recognizes both same-bundle instances and cross-bundle
     * shapes carrying the documented brand. Prefer this over
     * `instanceof InferenceSchemaError` in space `actions.ts` code, because
     * the worker bundle and the user actions bundle inline separate copies of
     * the SDK and therefore have separate class identities.
     */
    static is(value) {
        if (value instanceof InferenceSchemaError)
            return true;
        return (typeof value === "object" &&
            value !== null &&
            "__brand" in value &&
            value.__brand ===
                INFERENCE_SCHEMA_ERROR_BRAND &&
            "issues" in value &&
            Array.isArray(value.issues));
    }
}
// Managed-search vertical schemas plus their request/response types. These are
// defined in `./verticals` (the single source of truth, also consumed by the
// worker) and re-exported here so spaces import them from `@hatch/space-sdk`.
export { TOOL_FINANCE_RESULT_SCHEMA, TOOL_FINANCE_SCHEMA, TOOL_FINANCE_TICKER_RESULT_SCHEMA, TOOL_FINANCE_TICKER_SCHEMA, TOOL_SPORTS_DATA_RESULT_SCHEMA, TOOL_SPORTS_DATA_SCHEMA, TOOL_WEATHER_RESULT_SCHEMA, TOOL_WEATHER_SCHEMA, TOOL_WEB_SEARCH_RESULT_SCHEMA, TOOL_WEB_SEARCH_SCHEMA, } from "./verticals";
export function isAction(value) {
    return isSharedAction(value);
}
/**
 * Define a single action. The schemas drive both runtime validation (in the
 * worker) and static typing (on the client via `createActionClient`).
 */
export const defineAction = createDefineAction();
