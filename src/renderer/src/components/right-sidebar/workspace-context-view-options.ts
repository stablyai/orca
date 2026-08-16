import { useCallback, useState } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { ContextScopeFilter } from './workspace-context-model'

export const WORKSPACE_CONTEXT_VIEW_OPTIONS_STORAGE_KEY = 'orca.agentContext.viewOptions.v1'

export type ContextSectionKey = 'instructions' | 'skills' | 'mcp' | 'hooks' | 'plugins'
export type ContextSectionFilter = ContextSectionKey | 'all'
export const CONTEXT_SECTION_FILTERS: ContextSectionFilter[] = [
  'all',
  'instructions',
  'skills',
  'mcp',
  'hooks',
  'plugins'
]

/**
 * How the panel is being looked at. Agents are stored as the disabled set so a
 * newly discovered agent shows up enabled instead of silently filtered out.
 */
export type WorkspaceContextViewOptions = {
  disabledAgents: TuiAgent[]
  scope: ContextScopeFilter
  section: ContextSectionFilter
  showMissing: boolean
}

type ViewOptionsStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function createDefaultWorkspaceContextViewOptions(): WorkspaceContextViewOptions {
  return { disabledAgents: [], scope: 'all', section: 'all', showMissing: false }
}

function isScope(value: unknown): value is ContextScopeFilter {
  return value === 'workspace' || value === 'user' || value === 'all'
}

export function normalizeWorkspaceContextViewOptions(value: unknown): WorkspaceContextViewOptions {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const defaults = createDefaultWorkspaceContextViewOptions()
  return {
    disabledAgents: Array.isArray(record.disabledAgents)
      ? [...new Set(record.disabledAgents)].filter(isTuiAgent)
      : defaults.disabledAgents,
    scope: isScope(record.scope) ? record.scope : defaults.scope,
    section: CONTEXT_SECTION_FILTERS.includes(record.section as ContextSectionFilter)
      ? (record.section as ContextSectionFilter)
      : defaults.section,
    showMissing: typeof record.showMissing === 'boolean' ? record.showMissing : defaults.showMissing
  }
}

function rendererStorage(): ViewOptionsStorage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readWorkspaceContextViewOptions(
  storage: ViewOptionsStorage | null = rendererStorage()
): WorkspaceContextViewOptions {
  try {
    const raw = storage?.getItem(WORKSPACE_CONTEXT_VIEW_OPTIONS_STORAGE_KEY)
    return raw
      ? normalizeWorkspaceContextViewOptions(JSON.parse(raw))
      : createDefaultWorkspaceContextViewOptions()
  } catch {
    return createDefaultWorkspaceContextViewOptions()
  }
}

export function writeWorkspaceContextViewOptions(
  options: WorkspaceContextViewOptions,
  storage: ViewOptionsStorage | null = rendererStorage()
): void {
  try {
    storage?.setItem(
      WORKSPACE_CONTEXT_VIEW_OPTIONS_STORAGE_KEY,
      JSON.stringify(normalizeWorkspaceContextViewOptions(options))
    )
  } catch {
    // Why: a full or blocked localStorage only loses the preference, not the panel.
  }
}

/** Panel view options that survive tab switches and restarts (per client, like Session History). */
export function useWorkspaceContextViewOptions(): {
  options: WorkspaceContextViewOptions
  update: (patch: Partial<WorkspaceContextViewOptions>) => void
  setAgentEnabled: (agent: TuiAgent, enabled: boolean) => void
  setAllAgentsEnabled: (enabled: boolean, agents: readonly TuiAgent[]) => void
  reset: () => void
} {
  const [options, setOptions] = useState<WorkspaceContextViewOptions>(() =>
    readWorkspaceContextViewOptions()
  )
  const commit = useCallback(
    (next: (current: WorkspaceContextViewOptions) => WorkspaceContextViewOptions) =>
      setOptions((current) => {
        const candidate = next(current)
        writeWorkspaceContextViewOptions(candidate)
        return candidate
      }),
    []
  )
  const update = useCallback(
    (patch: Partial<WorkspaceContextViewOptions>) =>
      commit((current) => ({ ...current, ...patch })),
    [commit]
  )
  const setAgentEnabled = useCallback(
    (agent: TuiAgent, enabled: boolean) =>
      commit((current) => ({
        ...current,
        disabledAgents: enabled
          ? current.disabledAgents.filter((entry) => entry !== agent)
          : [...new Set([...current.disabledAgents, agent])]
      })),
    [commit]
  )
  const setAllAgentsEnabled = useCallback(
    (enabled: boolean, agents: readonly TuiAgent[]) =>
      commit((current) => ({ ...current, disabledAgents: enabled ? [] : [...agents] })),
    [commit]
  )
  const reset = useCallback(
    () =>
      commit((current) => ({
        ...createDefaultWorkspaceContextViewOptions(),
        section: current.section
      })),
    [commit]
  )
  return { options, update, setAgentEnabled, setAllAgentsEnabled, reset }
}
