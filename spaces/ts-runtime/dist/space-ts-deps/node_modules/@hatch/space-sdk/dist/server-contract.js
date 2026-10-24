import { z } from "zod";
export { z };
/**
 * Versioned brand for privileged function descriptors.
 *
 * Descriptors are the portable contract that action code imports and passes to
 * `ctx.executePrivileged(...)`. Host-capable implementations live in a
 * separate privileged bundle; action bundles should only carry descriptors.
 */
export const PRIVILEGED_CONTRACT_BRAND = "@hatch/space-sdk/privileged-contract/v1";
export const PRIVILEGED_HANDLERS_FORMAT = "hatch-space-privileged-handlers-v1";
export function definePrivilegedContracts(specs) {
    const contracts = {};
    for (const [name, spec] of Object.entries(specs)) {
        contracts[name] = {
            __brand: PRIVILEGED_CONTRACT_BRAND,
            name,
            request: spec.request,
            response: spec.response,
            ...(spec.capabilities !== undefined
                ? { capabilities: spec.capabilities }
                : {}),
            ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
        };
    }
    return contracts;
}
export function definePrivilegedHandlers(contracts, handlers) {
    const entries = [];
    for (const [key, handler] of Object.entries(handlers)) {
        if (handler === undefined) {
            continue;
        }
        const contract = contracts[key];
        if (!isPrivilegedContract(contract)) {
            throw new Error(`privileged handler '${key}' does not have a contract descriptor`);
        }
        entries.push({
            contract,
            handler: handler,
        });
    }
    return {
        format: PRIVILEGED_HANDLERS_FORMAT,
        entries,
    };
}
/** Runtime check used by workers to recognize privileged descriptors. */
export function isPrivilegedContract(value) {
    return (typeof value === "object" &&
        value !== null &&
        "__brand" in value &&
        value.__brand === PRIVILEGED_CONTRACT_BRAND);
}
export function isPrivilegedHandlers(value) {
    return (typeof value === "object" &&
        value !== null &&
        "format" in value &&
        value.format === PRIVILEGED_HANDLERS_FORMAT &&
        Array.isArray(value.entries));
}
export function createPrivilegedExecutor(declared, transport) {
    const declaredNames = new Set((declared ?? []).map((contract) => contract.name));
    return {
        async executePrivileged(contract, args) {
            if (!isPrivilegedContract(contract)) {
                throw new Error("ctx.executePrivileged requires a privileged contract descriptor");
            }
            if (!declaredNames.has(contract.name)) {
                throw new Error(`ctx.executePrivileged(${contract.name}) was not declared by this action`);
            }
            const parsedArgs = contract.request.parse(args);
            const result = await transport(contract, parsedArgs);
            return contract.response.parse(result);
        },
    };
}
/**
 * Versioned brand. Identifies a value as an action definition produced by
 * `defineAction(...)`. The worker scans module exports for objects carrying
 * this brand to build its dispatch table.
 *
 * Versioning lets a future SDK reject stale-shape actions explicitly. The
 * string shape is stable across independently bundled SDK copies; avoid Symbol
 * identity here because Cloudflare and local bundles intentionally inline
 * separate module copies.
 */
export const ACTION_BRAND = "@hatch/space-sdk/action/v1";
const LEGACY_ACTION_BRAND = Symbol.for("@hatch/space-sdk/action");
/** Bind the shared action implementation to a runtime-specific Ctx type. */
export function createDefineAction() {
    return function defineAction(spec) {
        return {
            __brand: ACTION_BRAND,
            request: spec.request,
            response: spec.response,
            ...(spec.privileged !== undefined ? { privileged: spec.privileged } : {}),
            handler: spec.handler,
        };
    };
}
/** Runtime check used by workers to filter module exports. */
export function isAction(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    if ("__brand" in value &&
        value.__brand === ACTION_BRAND) {
        return true;
    }
    return (value.kind === "action" &&
        value[LEGACY_ACTION_BRAND] === true);
}
