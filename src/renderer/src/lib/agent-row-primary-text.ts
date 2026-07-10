import type { AgentStatusEntry } from '../../../shared/agent-status-types'

export const ORCA_DISPATCH_PREAMBLE_PREFIX = 'You are working inside Orca, a multi-agent IDE.'
const ORCA_DISPATCH_TASK_MARKER = '=== TASK ==='
const ORCA_DISPATCH_TASK_ID_MARKER = 'Your task ID is:'
// Why: match deriveGeneratedTabTitle's scan budget — previews only need the
// first non-empty task line, not the rest of a paste-sized worker prompt.
const ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT = 512
// Why: task id lives near the top of the preamble; keep that scan tight.
const ORCA_DISPATCH_TASK_ID_SCAN_LIMIT = 1024
// Why: === TASK === sits after CLI instructions (a few KB). Cap the search so a
// malformed multi-MB prompt without a marker never full-scans the task body.
const ORCA_DISPATCH_TASK_MARKER_SCAN_LIMIT = 32_768

/** True when the live prompt is still an Orca dispatch turn (not sticky metadata alone). */
export function isOrcaDispatchPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(ORCA_DISPATCH_PREAMBLE_PREFIX)
}

/**
 * True when orchestration labels may label the live dispatch turn.
 * Reject only when both sides expose a taskId and they differ — sticky completed
 * metadata must not rename a later dispatch. When the live prompt is truncated
 * (agent-status fields are short) and has no parseable taskId, trust labels.
 */
export function orchestrationLabelsMatchLiveDispatch(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): boolean {
  if (!isOrcaDispatchPrompt(entry.prompt)) {
    return false
  }
  const orchestrationTaskId = entry.orchestration?.taskId?.trim()
  if (!orchestrationTaskId) {
    return false
  }
  const liveTaskId = getOrcaDispatchTaskId(entry.prompt)
  if (!liveTaskId) {
    return true
  }
  return liveTaskId === orchestrationTaskId
}

export function getAgentRowPrimaryText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string {
  if (orchestrationLabelsMatchLiveDispatch(entry)) {
    return (
      entry.orchestration?.displayName?.trim() ||
      entry.orchestration?.taskTitle?.trim() ||
      getOrcaDispatchTaskPreview(entry.prompt) ||
      // Why: non-dispatch and unmatched paths keep a full trim for display; this
      // branch only runs for matched dispatch turns, where a bounded preview
      // almost always succeeds first.
      entry.prompt.trimStart().slice(0, ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT).trim()
    )
  }
  return (
    getOrcaDispatchTaskPreview(entry.prompt) ||
    // Why: ordinary prompts stay small; dispatch prompts without a TASK marker
    // still must not full-trim a multi-MB body for a sidebar label.
    (isOrcaDispatchPrompt(entry.prompt)
      ? entry.prompt.trimStart().slice(0, ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT).trim()
      : entry.prompt.trim())
  )
}

export function getAgentRowGeneratedTitleText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string {
  // Why: only prefer orchestration/task labels while the live prompt is still
  // the same dispatch turn — sticky orchestration must not rename new work.
  if (isOrcaDispatchPrompt(entry.prompt)) {
    return getAgentRowPrimaryText(entry)
  }
  return entry.prompt
}

export function getOrcaDispatchTaskId(prompt: string): string | null {
  if (!isOrcaDispatchPrompt(prompt)) {
    return null
  }
  const scan = prompt.trimStart().slice(0, ORCA_DISPATCH_TASK_ID_SCAN_LIMIT)
  const markerIndex = scan.indexOf(ORCA_DISPATCH_TASK_ID_MARKER)
  if (markerIndex === -1) {
    return null
  }
  const afterMarker = scan.slice(markerIndex + ORCA_DISPATCH_TASK_ID_MARKER.length)
  const lineEnd = afterMarker.search(/\r|\n/)
  const idLine = (lineEnd === -1 ? afterMarker : afterMarker.slice(0, lineEnd)).trim()
  return idLine || null
}

function getOrcaDispatchTaskPreview(prompt: string): string {
  // Why: sidebar rows call this during render; never full-trim/split paste-sized
  // dispatch prompts — only scan bounded windows for the marker and first line.
  if (!isOrcaDispatchPrompt(prompt)) {
    return ''
  }
  const scan = prompt
    .trimStart()
    .slice(0, ORCA_DISPATCH_TASK_MARKER_SCAN_LIMIT + ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT)
  const taskMarkerIndex = scan.indexOf(ORCA_DISPATCH_TASK_MARKER)
  if (taskMarkerIndex === -1) {
    return ''
  }
  const taskBodyStart = taskMarkerIndex + ORCA_DISPATCH_TASK_MARKER.length
  const taskBody = scan.slice(taskBodyStart, taskBodyStart + ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT)
  for (const line of taskBody.split(/\r?\n/)) {
    const preview = line.trim().replace(/\s+/g, ' ')
    if (preview) {
      return preview
    }
  }
  return ''
}
