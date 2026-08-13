import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isTuiAgentEnabled, TUI_AGENT_AUTO_PICK_ORDER } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/types'

export type AgentTerminalThemeRowModel = {
  id: TuiAgent
  disabled: boolean
}

export type AgentDetectionMaps = {
  localDetectedIds: TuiAgent[] | null
  remoteDetectedAgentIds: Record<string, TuiAgent[] | null>
  runtimeDetectedAgentIds: Record<string, TuiAgent[] | null>
}

function addDetectedIds(ids: Set<TuiAgent>, values: TuiAgent[] | null | undefined): void {
  if (!values) {
    return
  }
  for (const id of values) {
    if (isTuiAgent(id)) {
      ids.add(id)
    }
  }
}

export function collectCachedDetectedAgentIds(
  maps: Record<string, TuiAgent[] | null>[]
): TuiAgent[] {
  const ids = new Set<TuiAgent>()
  for (const map of maps) {
    for (const values of Object.values(map)) {
      addDetectedIds(ids, values)
    }
  }
  return [...ids]
}

export function collectAgentTerminalThemeRows(
  detection: AgentDetectionMaps,
  persistedAgentKeys: Iterable<string>,
  disabledTuiAgents?: Iterable<unknown> | null
): AgentTerminalThemeRowModel[] {
  const detected = new Set<TuiAgent>()
  addDetectedIds(detected, detection.localDetectedIds)
  addDetectedIds(
    detected,
    collectCachedDetectedAgentIds([
      detection.remoteDetectedAgentIds,
      detection.runtimeDetectedAgentIds
    ])
  )

  const persisted = new Set<TuiAgent>()
  for (const key of persistedAgentKeys) {
    if (isTuiAgent(key)) {
      persisted.add(key)
    }
  }

  const union = new Set<TuiAgent>([...detected, ...persisted])
  return TUI_AGENT_AUTO_PICK_ORDER.filter((id) => union.has(id))
    .filter((id) => isTuiAgentEnabled(id, disabledTuiAgents) || persisted.has(id))
    .map((id) => ({
      id,
      disabled: !isTuiAgentEnabled(id, disabledTuiAgents)
    }))
}

export function isAgentTerminalThemeRowsLoading(args: {
  localDetectedIds: TuiAgent[] | null
  isLoading: boolean
  persistedKeyCount: number
  cachedDetectedIds: readonly TuiAgent[]
}): boolean {
  if (args.persistedKeyCount > 0 || args.cachedDetectedIds.length > 0) {
    return false
  }
  if (args.localDetectedIds !== null) {
    return false
  }
  return args.isLoading
}

export function isAgentTerminalThemeRowsFailed(args: {
  localDetectedIds: TuiAgent[] | null
  isLoading: boolean
  detectionFailed: boolean
  rowCount: number
}): boolean {
  if (args.rowCount > 0) {
    return false
  }
  return args.detectionFailed || (args.localDetectedIds === null && !args.isLoading)
}

export function isAgentTerminalThemeRowsEmptySuccess(args: {
  localDetectedIds: TuiAgent[] | null
  rowCount: number
  persistedKeyCount: number
}): boolean {
  return args.rowCount === 0 && args.persistedKeyCount === 0 && args.localDetectedIds !== null
}
