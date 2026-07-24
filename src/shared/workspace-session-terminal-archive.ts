import { isResumableTuiAgent, normalizeAgentProviderSession } from './agent-session-resume'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type {
  ArchivedTerminalLayout,
  ArchivedTerminalPane,
  TerminalArchiveCloseReason,
  TerminalArchiveHint,
  TerminalArchiveHintField,
  TerminalArchiveHintSource
} from './terminal-archive-types'
import { TERMINAL_ARCHIVE_HINT_FIELDS } from './terminal-archive-types'
import { makePaneKey } from './stable-pane-id'
import { isTuiAgent } from './tui-agent-config'
import type { TerminalLayoutSnapshot, TerminalTab, WorkspaceSessionState } from './types'
import { closeTerminalTabInWorkspaceSession } from './workspace-session-terminal-tab-close'

export type CapturedTerminalArchiveTab = {
  tab: TerminalTab
  layout: ArchivedTerminalLayout
  panesByLeafId: Record<string, ArchivedTerminalPane>
  sourcePaneIdentityByLeafId: Record<string, { paneKey: string; incarnationId: string }>
}

export type { TerminalArchiveHintSource } from './terminal-archive-types'

export function shouldArchiveTerminalClose(reason: TerminalArchiveCloseReason): boolean {
  return (
    reason === 'user-close' || reason === 'relay-worker-lost' || reason === 'daemon-worker-lost'
  )
}

function archiveLayout(layout: TerminalLayoutSnapshot | undefined): ArchivedTerminalLayout {
  return {
    root: layout?.root ? structuredClone(layout.root) : null,
    activeLeafId: layout?.activeLeafId ?? null,
    expandedLeafId: layout?.expandedLeafId ?? null,
    ...(layout?.titlesByLeafId ? { titlesByLeafId: { ...layout.titlesByLeafId } } : {})
  }
}

function collectLeafIds(node: ArchivedTerminalLayout['root'], output: string[] = []): string[] {
  if (!node) {
    return output
  }
  if (node.type === 'leaf') {
    output.push(node.leafId)
    return output
  }
  collectLeafIds(node.first, output)
  collectLeafIds(node.second, output)
  return output
}

function paneFromHint(
  leafId: string,
  tab: TerminalTab,
  hint: TerminalArchiveHint | undefined
): ArchivedTerminalPane {
  const providerSession = hint?.providerSession
  const agent = hint?.launchAgent
  return {
    archivedLeafId: leafId,
    cwd: hint?.cwd ?? tab.startupCwd ?? '',
    ...((hint?.shellOverride ?? tab.shellOverride)
      ? { shellOverride: hint?.shellOverride ?? tab.shellOverride }
      : {}),
    ...(hint?.startupCommand ? { startupCommand: hint.startupCommand } : {}),
    ...(hint?.startedAt !== undefined ? { startedAt: hint.startedAt } : {}),
    ...(agent && providerSession && isResumableTuiAgent(agent)
      ? { agent: { type: agent, providerSession } }
      : {}),
    ...(hint?.orchestrationTaskId ? { orchestrationTaskId: hint.orchestrationTaskId } : {})
  }
}

/** Captures only durable, non-process identity. PTY ids and incarnations deliberately stay out. */
export function captureTerminalArchiveTab(args: {
  session: WorkspaceSessionState
  worktreeId: string
  tabId: string
}): CapturedTerminalArchiveTab | null {
  const tab = args.session.tabsByWorktree[args.worktreeId]?.find((entry) => entry.id === args.tabId)
  if (!tab) {
    return null
  }
  const layout = archiveLayout(args.session.terminalLayoutsByTabId[args.tabId])
  const leafIds = collectLeafIds(layout.root)
  if (leafIds.length === 0) {
    return null
  }
  const panesByLeafId: Record<string, ArchivedTerminalPane> = {}
  const sourcePaneIdentityByLeafId: CapturedTerminalArchiveTab['sourcePaneIdentityByLeafId'] = {}
  for (const leafId of leafIds) {
    const paneKey = makePaneKey(args.tabId, leafId)
    const incarnationId = args.session.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (!incarnationId) {
      return null
    }
    panesByLeafId[leafId] = paneFromHint(
      leafId,
      tab,
      args.session.terminalArchiveHintsByPaneKey?.[paneKey]
    )
    sourcePaneIdentityByLeafId[leafId] = { paneKey, incarnationId }
  }
  return { tab: { ...tab }, layout, panesByLeafId, sourcePaneIdentityByLeafId }
}

export function retireArchivedTerminalTab(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): ReturnType<typeof closeTerminalTabInWorkspaceSession> {
  const closed = closeTerminalTabInWorkspaceSession(session, worktreeId, tabId)
  if (!closed.closed || !session.terminalArchiveHintsByPaneKey) {
    return closed
  }
  const hints = { ...session.terminalArchiveHintsByPaneKey }
  for (const paneKey of Object.keys(hints)) {
    if (paneKey.startsWith(`${tabId}:`)) {
      delete hints[paneKey]
    }
  }
  const { terminalArchiveHintsByPaneKey: _removedHints, ...sessionWithoutHints } = closed.session
  return {
    ...closed,
    session: {
      ...sessionWithoutHints,
      ...(Object.keys(hints).length > 0 ? { terminalArchiveHintsByPaneKey: hints } : {})
    }
  }
}

function normalizeHint(input: Partial<TerminalArchiveHint>): Partial<TerminalArchiveHint> {
  const providerSession = normalizeAgentProviderSession(input.providerSession)
  return {
    ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
    ...(typeof input.startupCommand === 'string' && input.startupCommand
      ? { startupCommand: input.startupCommand }
      : {}),
    ...(typeof input.shellOverride === 'string' && input.shellOverride
      ? { shellOverride: input.shellOverride }
      : {}),
    ...(isTuiAgent(input.launchAgent) ? { launchAgent: input.launchAgent } : {}),
    ...(providerSession ? { providerSession } : {}),
    ...(typeof input.orchestrationTaskId === 'string' &&
    input.orchestrationTaskId.length > 0 &&
    input.orchestrationTaskId.length <= 512 &&
    input.orchestrationTaskId.trim() === input.orchestrationTaskId
      ? { orchestrationTaskId: input.orchestrationTaskId }
      : {}),
    ...(typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
      ? { startedAt: input.startedAt }
      : {})
  }
}

const terminalArchiveHintSourceRank: Record<TerminalArchiveHintSource, number> = {
  spawn: 0,
  launch: 1,
  'sleeping-session': 2,
  hook: 3
}

function mergeHintField<K extends TerminalArchiveHintField>(args: {
  current: TerminalArchiveHint | undefined
  incoming: Partial<TerminalArchiveHint>
  source: TerminalArchiveHintSource
  field: K
  merged: Partial<TerminalArchiveHint>
  fieldSources: NonNullable<TerminalArchiveHint['fieldSources']>
}): void {
  const currentValue = args.current?.[args.field]
  const incomingValue = args.incoming[args.field]
  const currentSource = args.current?.fieldSources?.[args.field] ?? 'spawn'
  if (
    incomingValue !== undefined &&
    (currentValue === undefined ||
      terminalArchiveHintSourceRank[args.source] >= terminalArchiveHintSourceRank[currentSource])
  ) {
    args.merged[args.field] = incomingValue
    args.fieldSources[args.field] = args.source
    return
  }
  if (currentValue !== undefined) {
    args.merged[args.field] = currentValue
    if (args.current?.fieldSources?.[args.field]) {
      args.fieldSources[args.field] = args.current.fieldSources[args.field]
    }
  }
}

/** Hook and sleeping-session facts are more authoritative than launch defaults. */
export function mergeTerminalArchiveHint(
  current: TerminalArchiveHint | undefined,
  incoming: Partial<TerminalArchiveHint>,
  source: TerminalArchiveHintSource
): TerminalArchiveHint {
  const next = normalizeHint(incoming)
  const merged: Partial<TerminalArchiveHint> = {}
  const fieldSources: NonNullable<TerminalArchiveHint['fieldSources']> = {}
  for (const field of TERMINAL_ARCHIVE_HINT_FIELDS) {
    mergeHintField({ current, incoming: next, source, field, merged, fieldSources })
  }
  const startedAt =
    current?.startedAt !== undefined && next.startedAt !== undefined
      ? Math.min(current.startedAt, next.startedAt)
      : (current?.startedAt ?? next.startedAt)
  return {
    ...merged,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(Object.keys(fieldSources).length > 0 ? { fieldSources } : {})
  } as TerminalArchiveHint
}

export function mergeTerminalArchiveHintIntoSession(args: {
  session: WorkspaceSessionState
  paneKey: string
  hint: Partial<TerminalArchiveHint>
  source: TerminalArchiveHintSource
}): WorkspaceSessionState {
  const current = args.session.terminalArchiveHintsByPaneKey?.[args.paneKey]
  return {
    ...args.session,
    terminalArchiveHintsByPaneKey: {
      ...args.session.terminalArchiveHintsByPaneKey,
      [args.paneKey]: mergeTerminalArchiveHint(current, args.hint, args.source)
    }
  }
}

/** Moves the two pane-keyed durable facts together when main proves PTY ownership. */
export function moveTerminalArchivePaneDurableState(args: {
  session: WorkspaceSessionState
  fromPaneKey: string
  toPaneKey: string
}): WorkspaceSessionState {
  if (args.fromPaneKey === args.toPaneKey) {
    return args.session
  }
  const hint = args.session.terminalArchiveHintsByPaneKey?.[args.fromPaneKey]
  const incarnation = args.session.terminalPtyIncarnationsByPaneKey?.[args.fromPaneKey]
  if (!hint && !incarnation) {
    return args.session
  }
  const hints = { ...args.session.terminalArchiveHintsByPaneKey }
  const incarnations = { ...args.session.terminalPtyIncarnationsByPaneKey }
  if (hint) {
    hints[args.toPaneKey] = hint
    delete hints[args.fromPaneKey]
  }
  if (incarnation) {
    incarnations[args.toPaneKey] = incarnation
    delete incarnations[args.fromPaneKey]
  }
  return {
    ...args.session,
    ...(Object.keys(hints).length > 0 ? { terminalArchiveHintsByPaneKey: hints } : {}),
    ...(Object.keys(incarnations).length > 0
      ? { terminalPtyIncarnationsByPaneKey: incarnations }
      : {})
  }
}

export type TerminalArchivePaneSnapshotInput = {
  kind: 'captured-bytes'
  buffer: string
  source: 'renderer' | 'daemon-headless' | 'relay-tail' | 'session-sidecar'
  truncated: boolean
  byteLength: number
}

export type TerminalArchivePaneSnapshotCapture =
  | TerminalArchivePaneSnapshotInput
  | { kind: 'captured-empty' }
  | { kind: 'unavailable' }

export type TerminalArchiveSnapshotSource = {
  capture(pane: ArchivedTerminalPane): Promise<TerminalArchivePaneSnapshotCapture>
}

/** The Store sees one capture seam; this adapter keeps authority order consistent across hosts. */
export function createPrioritizedTerminalArchiveSnapshotSource(sources: {
  daemonAuthoritative?: TerminalArchiveSnapshotSource
  rendererSerializer?: TerminalArchiveSnapshotSource
  sessionSidecar?: TerminalArchiveSnapshotSource
  relayTail?: TerminalArchiveSnapshotSource
}): TerminalArchiveSnapshotSource {
  const ordered = [
    sources.daemonAuthoritative,
    sources.rendererSerializer,
    sources.sessionSidecar,
    sources.relayTail
  ]
  return {
    async capture(pane) {
      for (const source of ordered) {
        const captured = await source?.capture(pane)
        if (captured && captured.kind !== 'unavailable') {
          return captured
        }
      }
      return { kind: 'unavailable' }
    }
  }
}

export type TerminalArchiveProviderSession = AgentProviderSessionMetadata
