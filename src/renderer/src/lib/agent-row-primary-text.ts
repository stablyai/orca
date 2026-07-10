import type { AgentStatusEntry } from '../../../shared/agent-status-types'

const ORCA_DISPATCH_PREAMBLE_PREFIX = 'You are working inside Orca, a multi-agent IDE.'
const ORCA_DISPATCH_TASK_MARKER = '=== TASK ==='

export function getAgentRowPrimaryText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string {
  return (
    entry.orchestration?.displayName?.trim() ||
    entry.orchestration?.taskTitle?.trim() ||
    getOrcaDispatchTaskPreview(entry.prompt) ||
    entry.prompt.trim()
  )
}

export function getAgentRowGeneratedTitleText(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string {
  if (
    entry.orchestration?.displayName?.trim() ||
    entry.orchestration?.taskTitle?.trim() ||
    entry.prompt.startsWith(ORCA_DISPATCH_PREAMBLE_PREFIX)
  ) {
    return getAgentRowPrimaryText(entry)
  }
  return entry.prompt
}

function getOrcaDispatchTaskPreview(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed.startsWith(ORCA_DISPATCH_PREAMBLE_PREFIX)) {
    return ''
  }
  const taskMarkerIndex = trimmed.indexOf(ORCA_DISPATCH_TASK_MARKER)
  if (taskMarkerIndex === -1) {
    return ''
  }
  const taskBody = trimmed.slice(taskMarkerIndex + ORCA_DISPATCH_TASK_MARKER.length)
  for (const line of taskBody.split(/\r?\n/)) {
    const preview = line.trim().replace(/\s+/g, ' ')
    if (preview) {
      return preview
    }
  }
  return ''
}
