import type { AgentStatusEntry } from './agent-status-types'
import {
  findOrcaDispatchPreambleStart,
  findOrcaDispatchTaskMarkerIndex,
  ORCA_DISPATCH_STATUS_TASK_MARKER
} from './orca-dispatch-status-prompt'

const ORCA_DISPATCH_TASK_MARKER = ORCA_DISPATCH_STATUS_TASK_MARKER
const ORCA_DISPATCH_TASK_ID_MARKER = 'Your task ID is:'
// Match the generated-title scan budget; previews need only the first nonempty task line.
const ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT = 512
const ORCA_DISPATCH_TASK_ID_SCAN_LIMIT = 1024
// Bound searches past multi-KB CLI preambles so malformed large prompts cannot force a full scan.
const ORCA_DISPATCH_TASK_MARKER_SCAN_LIMIT = 32_768

/** True when the live prompt is still an Orca dispatch turn (not sticky metadata alone). */
export function isOrcaDispatchPrompt(prompt: string): boolean {
  return findOrcaDispatchPreambleStart(prompt) !== -1
}

/** Only matching live dispatch task IDs may use sticky labels; missing IDs in truncated status prompts still trust labels. */
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
  // Prefer matching task labels, then TASK-body preview; never expose folded lifecycle boilerplate.
  if (orchestrationLabelsMatchLiveDispatch(entry)) {
    return (
      entry.orchestration?.displayName?.trim() ||
      entry.orchestration?.taskTitle?.trim() ||
      getOrcaDispatchTaskPreview(entry.prompt)
    )
  }
  if (isOrcaDispatchPrompt(entry.prompt)) {
    return getOrcaDispatchTaskPreview(entry.prompt)
  }
  return entry.prompt.trim()
}

export function getAgentRowGeneratedTitleText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string {
  // Sticky dispatch labels must not rename later work.
  if (isOrcaDispatchPrompt(entry.prompt)) {
    return getAgentRowPrimaryText(entry)
  }
  return entry.prompt
}

export function getOrcaDispatchTaskId(prompt: string): string | null {
  const start = findOrcaDispatchPreambleStart(prompt)
  if (start === -1) {
    return null
  }
  const scan = prompt.slice(start, start + ORCA_DISPATCH_TASK_ID_SCAN_LIMIT)
  const markerIndex = scan.indexOf(ORCA_DISPATCH_TASK_ID_MARKER)
  if (markerIndex === -1) {
    return null
  }
  // Status normalization folds newlines to spaces; delimit task IDs on any whitespace.
  const afterMarker = scan.slice(markerIndex + ORCA_DISPATCH_TASK_ID_MARKER.length).trimStart()
  const idEnd = afterMarker.search(/\s/)
  const idLine = idEnd === -1 ? afterMarker : afterMarker.slice(0, idEnd)
  return idLine || null
}

function getOrcaDispatchTaskPreview(prompt: string): string {
  // Render only bounded marker/preview windows; accept both raw multiline preambles and normalized 200-char single-line task bodies.
  const start = findOrcaDispatchPreambleStart(prompt)
  if (start === -1) {
    return ''
  }
  const scan = prompt.slice(
    start,
    start + ORCA_DISPATCH_TASK_MARKER_SCAN_LIMIT + ORCA_DISPATCH_TASK_PREVIEW_SCAN_LIMIT
  )
  // Share standalone-marker rules so base-drift subjects cannot impersonate the real task separator.
  const taskMarkerIndex = findOrcaDispatchTaskMarkerIndex(scan)
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
