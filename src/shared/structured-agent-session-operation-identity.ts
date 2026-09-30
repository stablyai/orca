/**
 * Whether a structured-session write names what it acts on (a turn, a prompt, a task, a draft), so
 * another with the same payload is the same intent and may reuse its operation id to replay. A Stop
 * naming no turn, one stopping every background task, or a queue Resume acts on whatever holds when
 * the host reaches it: its payload is shared with every later one, so each press gets its own id.
 */
export function structuredAgentSessionWriteNamesItsTarget(
  fingerprintMethod: string,
  fields: Readonly<Record<string, unknown>>
): boolean {
  if (fingerprintMethod === 'agentSession.queuedMessagesResume') {
    return false
  }
  if (fingerprintMethod !== 'agentSession.cancel') {
    return true
  }
  return fields.scope === 'background-tasks'
    ? fields.taskId !== undefined
    : fields.turnId !== undefined
}
