// Why: hook tool-lifecycle events are used in both main-process status guards
// and renderer completion notifications; keep the allowlist in one place.
const TOOL_PROGRESS_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

export function isToolProgressHookEvent(hookEventName: unknown): hookEventName is string {
  return typeof hookEventName === 'string' && TOOL_PROGRESS_HOOK_EVENTS.has(hookEventName)
}
