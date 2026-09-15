import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { readString } from '../tool-input-preview'

export function isCodexNonInteractivePermissionRequest(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  // Codex maps approval_policy=never to bypassPermissions; this hook cannot ask a human.
  return (
    eventName === 'PermissionRequest' &&
    hookPayload.permission_mode === 'bypassPermissions' &&
    !isAskUserQuestionTool(readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name'))
  )
}
