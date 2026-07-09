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
  isFocused: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function candidateLabel(args: {
  paneKey: string
  state: ActiveTerminalPaneKeyState
  isFocused: boolean
}): string {
  const entry = args.state.agentStatusByPaneKey?.[args.paneKey]
  let prompt = ''
  let agentType = ''
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

  const base =
    (prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt) ||
    tabTitle ||
    agentType ||
    args.paneKey.slice(0, 20)
  return args.isFocused ? `${base} (focused)` : base
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
    .map((paneKey) => ({
      paneKey,
      isFocused: paneKey === focused,
      label: candidateLabel({
        paneKey,
        state: args.state,
        isFocused: paneKey === focused
      })
    }))
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
