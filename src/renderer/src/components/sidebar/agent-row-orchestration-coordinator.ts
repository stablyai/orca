import type { TerminalPaneLayoutNode } from '../../../../shared/types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'

export type ActiveTerminalPaneKeyState = {
  activeTabType: string | null
  activeTabId: string | null
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string }[] | undefined>
  terminalLayoutsByTabId: Record<
    string,
    { activeLeafId?: string | null; root?: TerminalPaneLayoutNode | null } | undefined
  >
  agentStatusByPaneKey?: Record<string, unknown>
}

// Why: the focused terminal is the natural coordinator for sidebar-driven
// dispatch — same identity the agent list already highlights as "focused pane".
export function getActiveTerminalPaneKey(state: ActiveTerminalPaneKeyState): string | null {
  if (state.activeTabType !== 'terminal' || !state.activeTabId) {
    return null
  }
  const activeLeafId = state.terminalLayoutsByTabId[state.activeTabId]?.activeLeafId
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return null
  }
  return makePaneKey(state.activeTabId, activeLeafId)
}

function collectLeafIds(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

function collectWorktreeTerminalPaneKeys(
  state: ActiveTerminalPaneKeyState,
  worktreeId: string
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const push = (paneKey: string): void => {
    if (seen.has(paneKey)) {
      return
    }
    seen.add(paneKey)
    keys.push(paneKey)
  }

  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const layout = state.terminalLayoutsByTabId[tab.id]
    const leafIds = collectLeafIds(layout?.root ?? null)
    if (leafIds.length === 0 && layout?.activeLeafId) {
      leafIds.push(layout.activeLeafId)
    }
    for (const leafId of leafIds) {
      if (isTerminalLeafId(leafId)) {
        push(makePaneKey(tab.id, leafId))
      }
    }
  }

  // Why: agent rows can exist before layout leaves are fully hydrated; also
  // prefer known agents as coordinator candidates.
  for (const paneKey of Object.keys(state.agentStatusByPaneKey ?? {})) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const tabBelongs = (state.tabsByWorktree[worktreeId] ?? []).some(
      (tab) => tab.id === parsed.tabId
    )
    if (tabBelongs) {
      push(paneKey)
    }
  }

  return keys
}

export type CoordinatorCandidate = {
  paneKey: string
  label: string
  /** Raw agent type for icon mapping (claude, codex, grok, …). */
  agentType: string | null
  isFocused: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCandidateMeta(args: {
  paneKey: string
  state: ActiveTerminalPaneKeyState
  isFocused: boolean
}): { label: string; agentType: string | null } {
  const entry = args.state.agentStatusByPaneKey?.[args.paneKey]
  let prompt = ''
  let agentType: string | null = null
  if (isRecord(entry)) {
    if (typeof entry.prompt === 'string' && entry.prompt.trim()) {
      prompt = entry.prompt.trim()
    }
    if (typeof entry.agentType === 'string' && entry.agentType.trim()) {
      agentType = entry.agentType.trim()
    }
  }
  const parsed = parsePaneKey(args.paneKey)
  const tab = parsed
    ? Object.values(args.state.tabsByWorktree)
        .flatMap((tabs) => tabs ?? [])
        .find((t) => t.id === parsed.tabId)
    : undefined
  const tabTitle =
    tab && 'title' in tab && typeof (tab as { title?: unknown }).title === 'string'
      ? String((tab as { title: string }).title).trim()
      : ''
  // Why: tab titles like "Claude Code" often encode agent identity when status
  // has not reported agentType yet.
  if (!agentType && tabTitle) {
    const lower = tabTitle.toLowerCase()
    if (lower.includes('claude')) {
      agentType = 'claude'
    } else if (lower.includes('codex')) {
      agentType = 'codex'
    } else if (lower.includes('grok')) {
      agentType = 'grok'
    } else if (lower.includes('gemini')) {
      agentType = 'gemini'
    } else if (lower.includes('opencode')) {
      agentType = 'opencode'
    }
  }

  const detail =
    (prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt) ||
    tabTitle ||
    args.paneKey.slice(0, 16)
  const base = agentType ? `${agentType} · ${detail}` : detail
  return {
    agentType,
    label: args.isFocused ? `${base} (focused)` : base
  }
}

// Why: the dialog must list explicit coordinator choices; users should not have
// to guess which terminal is --from when right-click selected the worker.
export function listCoordinatorCandidates(args: {
  workerPaneKey: string
  workerWorktreeId: string | null
  state: ActiveTerminalPaneKeyState
}): CoordinatorCandidate[] {
  const worktreeId = args.workerWorktreeId ?? args.state.activeWorktreeId
  if (!worktreeId) {
    return []
  }
  const focused = getActiveTerminalPaneKey(args.state)
  return collectWorktreeTerminalPaneKeys(args.state, worktreeId)
    .filter((paneKey) => paneKey !== args.workerPaneKey)
    .map((paneKey) => {
      const isFocused = paneKey === focused
      const meta = readCandidateMeta({ paneKey, state: args.state, isFocused })
      return {
        paneKey,
        isFocused,
        label: meta.label,
        agentType: meta.agentType
      }
    })
}

// Why: right-clicking an agent often focuses that same terminal, so "focused =
// coordinator" would equal the worker. Prefer focused only when distinct; else
// pick another terminal in the worker's worktree.
export function resolveCoordinatorPaneKey(args: {
  workerPaneKey: string
  workerWorktreeId: string | null
  state: ActiveTerminalPaneKeyState
}): string | null {
  const candidates = listCoordinatorCandidates(args)
  if (candidates.length === 0) {
    return null
  }
  const focusedCandidate = candidates.find((c) => c.isFocused)
  return focusedCandidate?.paneKey ?? candidates[0]?.paneKey ?? null
}
