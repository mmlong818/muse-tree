# shellcheck shell=bash

_HATCH_HOOK_DISABLE_AFTER_RUN=false

_hatch_hook_compact_json() {
    local value="${1-}"
    printf '%s' "$value" | jq -ce '.'
}

_hatch_hook_object_json() {
    local value="${1-}"
    printf '%s' "$value" | jq -ce 'select(type == "object")'
}

_hatch_hook_emit() {
    local decision="$1"
    local reason="${2-}"
    local payload="${3-}"
    local result

    if [[ -n "$payload" ]]; then
        payload="$(_hatch_hook_compact_json "$payload")" || return
        result="$(
            jq -cn \
                --arg decision "$decision" \
                --arg reason "$reason" \
                --argjson payload "$payload" \
                --argjson disable_after_run "$_HATCH_HOOK_DISABLE_AFTER_RUN" \
                '{
                    decision: $decision,
                    reason: $reason,
                    payload: $payload
                } + if $disable_after_run then {disable_after_run: true} else {} end'
        )" || return
    else
        result="$(
            jq -cn \
                --arg decision "$decision" \
                --arg reason "$reason" \
                --argjson disable_after_run "$_HATCH_HOOK_DISABLE_AFTER_RUN" \
                '{
                    decision: $decision,
                    reason: $reason
                } + if $disable_after_run then {disable_after_run: true} else {} end'
        )" || return
    fi

    printf 'HATCH_HOOK_RESULT:%s\n' "$result"
    exit 0
}

silent() {
    _hatch_hook_emit "silent" "${1-}" "${2-}"
}

wake() {
    _hatch_hook_emit "wake" "${1-}" "${2-}"
}

disable_after_run() {
    _HATCH_HOOK_DISABLE_AFTER_RUN=true
}

log() {
    local message="${1-}"
    local fields="${2-}"
    local entry

    if [[ -z "$fields" ]]; then
        fields='{}'
    fi
    fields="$(_hatch_hook_object_json "$fields")" || return
    entry="$(
        jq -cn \
            --arg message "$message" \
            --argjson fields "$fields" \
            '$fields + {message: $message}'
    )" || return
    printf 'HATCH_HOOK_LOG:%s\n' "$entry" >&2
}

_hatch_hook_state_path() {
    printf '%s/%s.json' "${HATCH_HOOK_STATE_DIR:?HATCH_HOOK_STATE_DIR is unset}" \
        "${HATCH_HOOK_ID:?HATCH_HOOK_ID is unset}"
}

# Read this hook's persisted state object. Prints `{}` when nothing has been
# stored yet or the stored file is unreadable/corrupt, so callers can pipe
# straight into jq without a first-run special case.
hook_state_get() {
    local path
    path="$(_hatch_hook_state_path)" || return
    if [[ ! -f "$path" ]]; then
        printf '{}'
        return 0
    fi
    jq -ce 'select(type == "object")' <"$path" 2>/dev/null || printf '{}'
}

# Persist this hook's state object. The value is validated on every run, but
# the write is SKIPPED on dry runs so testing a hook can never consume a
# detection the next live poll still needs to make.
hook_state_set() {
    local value path temporary
    value="$(_hatch_hook_object_json "${1-}")" || return
    if [[ "${HATCH_HOOK_DRY_RUN-0}" == "1" ]]; then
        return 0
    fi
    path="$(_hatch_hook_state_path)" || return
    temporary="${path}.${HATCH_HOOK_INVOCATION_ID:-$$}.tmp"
    printf '%s\n' "$value" >"$temporary" || return
    mv -f "$temporary" "$path"
}

