/**
 * Whether a structured-session cancel names what it stops (a turn, a prompt, a task), so another
 * cancel with the same payload is the same intent and may reuse its operation id to replay. A Stop
 * naming no turn, or one stopping every background task, acts on whatever is in flight when the
 * host reaches it: its payload is shared with every later one, so each press gets its own id.
 */
export function structuredAgentSessionWriteNamesItsTarget(
  fingerprintMethod: string,
  fields: Readonly<Record<string, unknown>>
): boolean {
  if (fingerprintMethod !== 'agentSession.cancel') {
    return true
  }
  return fields.scope === 'background-tasks'
    ? fields.taskId !== undefined
    : fields.turnId !== undefined
}
