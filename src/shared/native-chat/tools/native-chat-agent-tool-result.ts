export type NativeChatAgentToolResult = {
  tool: string
  status: string | null
  receiverThreadIds: readonly string[]
  states: readonly { threadId: string; status: string | null; message: string | null }[]
}

/** Codex's own words for a helper's `CollabAgentStatus`, as its client shows them. */
const HELPER_STATUS_TEXT = new Map<string, string>([
  ['pendingInit', 'Pending init'],
  ['running', 'Running'],
  ['interrupted', 'Interrupted'],
  ['completed', 'Completed'],
  ['shutdown', 'Shutdown'],
  ['notFound', 'Not found']
])

const CALL_STATUS_TEXT = new Map<string, string>([
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['interrupted', 'Interrupted']
])

type HelperState = NativeChatAgentToolResult['states'][number]

function statusSummary(state: HelperState): string | null {
  if (state.status === 'errored') {
    return `Error - ${state.message ?? 'Agent errored'}`
  }
  if (state.status === 'completed' && state.message) {
    return `Completed - ${state.message}`
  }
  return state.status === null ? null : (HELPER_STATUS_TEXT.get(state.status) ?? state.status)
}

// Every finished call needs output to preserve result pairing on older desktop/mobile clients.
export function nativeChatAgentToolResultText(
  call: NativeChatAgentToolResult,
  helperName?: (threadId: string) => string | null
): string | null {
  if (call.status === null || call.status === 'inProgress') {
    return null
  }
  // Spawn/close snapshots predate the action, so report the action instead.
  switch (call.tool) {
    case 'spawnAgent':
      return call.receiverThreadIds.length > 0 ? 'Spawned' : 'Agent spawn failed'
    case 'sendInput':
      return 'Sent input'
    case 'closeAgent':
      return 'Closed'
    case 'resumeAgent':
      return (call.states[0] && statusSummary(call.states[0])) ?? 'Error - Agent resume failed'
  }
  const reports = call.states.flatMap((state) => {
    const text =
      call.tool === 'wait' && state.status === 'completed' && state.message
        ? state.message
        : statusSummary(state)
    return text === null ? [] : [{ threadId: state.threadId, text }]
  })
  if (reports.length === 0) {
    // Timed-out waits and v2 wait completions can report no helper states.
    return call.tool === 'wait'
      ? 'Finished waiting'
      : (CALL_STATUS_TEXT.get(call.status) ?? call.status)
  }
  if (reports.length === 1 && call.receiverThreadIds.length === 1) {
    return reports[0].text
  }
  return reports
    .map(({ threadId, text }) => `${helperName?.(threadId) ?? threadId}: ${text}`)
    .join('\n')
}
