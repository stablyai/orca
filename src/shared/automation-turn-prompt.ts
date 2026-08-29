const AUTOMATION_TURN_PREFIX = '<!-- ORCA_AUTOMATION_RUN_ID:'
const AUTOMATION_TURN_SUFFIX = ' -->'

/** Adds authority-generated turn identity without changing the user's task body. */
export function buildAutomationTurnPrompt(prompt: string, runId: string): string {
  return `${AUTOMATION_TURN_PREFIX}${runId}${AUTOMATION_TURN_SUFFIX}\n${prompt}`
}

/** Index of the marker's closing suffix, or -1. Single source of truth so identity
 *  matching and publication stripping can never disagree about what the marker is. */
function findAutomationTurnMarkerEnd(prompt: string): number {
  if (!prompt.startsWith(AUTOMATION_TURN_PREFIX)) {
    return -1
  }
  const markerEnd = prompt.indexOf(AUTOMATION_TURN_SUFFIX, AUTOMATION_TURN_PREFIX.length)
  const delimiter = prompt[markerEnd + AUTOMATION_TURN_SUFFIX.length]
  if (markerEnd <= AUTOMATION_TURN_PREFIX.length || (delimiter !== '\n' && delimiter !== ' ')) {
    return -1
  }
  return markerEnd
}

export function isAutomationTurnPrompt(prompt: string, runId?: string): boolean {
  const markerEnd = findAutomationTurnMarkerEnd(prompt)
  if (markerEnd === -1) {
    return false
  }
  const markerRunId = prompt.slice(AUTOMATION_TURN_PREFIX.length, markerEnd)
  return runId === undefined || markerRunId === runId
}

/** Drops the turn marker from prompt text leaving the host. Rule 3: an old paired
 *  client renders published status content verbatim, so the marker must not reach it. */
export function stripAutomationTurnMarker(prompt: string): string {
  const markerEnd = findAutomationTurnMarkerEnd(prompt)
  return markerEnd === -1
    ? prompt
    : // +1 drops the single delimiter, whether raw '\n' or the space normalization folds it to.
      prompt.slice(markerEnd + AUTOMATION_TURN_SUFFIX.length + 1)
}

/** Strips the marker from every prompt an agent-status row publishes, including the
 *  per-turn history prompts a client renders as activity blocks. */
export function stripAutomationTurnMarkerFromPublishedStatus<
  TStatus extends { prompt: string; stateHistory?: readonly { prompt: string }[] }
>(status: TStatus): TStatus {
  const prompt = stripAutomationTurnMarker(status.prompt)
  let historyChanged = false
  const stateHistory = status.stateHistory?.map((entry) => {
    const entryPrompt = stripAutomationTurnMarker(entry.prompt)
    if (entryPrompt === entry.prompt) {
      return entry
    }
    historyChanged = true
    return { ...entry, prompt: entryPrompt }
  })
  if (prompt === status.prompt && !historyChanged) {
    return status
  }
  return { ...status, prompt, ...(stateHistory ? { stateHistory } : {}) }
}
