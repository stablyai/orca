import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store/index'
import { resolveWorktreeOperationRouteForHost } from '@/lib/workspace/ownership/worktree-operation-route'
import { runtimeEnvironmentCapabilityProof } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { normalizeExecutionHostId } from '../../../../../../shared/execution-host'
import type { SessionReadTerminalHistoryResult } from '../../../../../../shared/rpc-contract/session-terminal-history-params'
import { SESSION_TERMINAL_HISTORY_READ_RUNTIME_CAPABILITY } from '../../../../../../shared/session-tabs-runtime-capabilities'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { toHostSessionPaneKey } from '../../../../../../shared/workspace-layout/terminal-surface-id'
import { collectLeafIds } from '../../../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { hasClosedTerminalTabRecord } from '../../../../../../shared/workspace-layout/closed-terminal-tab-tombstones'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { resolvePositiveTerminalDimensions } from '../../snapshots/terminal-snapshot-replay-paint'
import { resolveTerminalPaneOwnerContext } from '../../host-state/terminal-pane-owner-context'
import { resolveTerminalTabId } from '../terminal-tab-id'

const CLEAR_HELD_SCREEN = '\x1b[0m\x1b[2J\x1b[3J\x1b[H'
export type RetainedTerminalHistory = {
  sessionId: string | null
  painted: boolean
  reading?: Promise<void>
  readIdentity?: string
  prepareFresh?: () => void
}
export type TerminalHistoryReadOwner = {
  environmentId: string | null
  pairingRevision: number | undefined
}
type HeldSession = Pick<
  ConnectPanePtySession,
  'retainedTerminalHistory' | 'pane' | 'writeReplayData'
>

/** The same connection owns the held image across attempts; old reads still carry their generation. */
export function holdRetainedTerminalHistory(
  session: HeldSession,
  sessionId: string | null
): RetainedTerminalHistory {
  if (session.retainedTerminalHistory?.sessionId !== sessionId) {
    session.retainedTerminalHistory = { sessionId, painted: false }
  }
  session.pane.terminal.options.disableStdin = true
  return session.retainedTerminalHistory!
}

export function acceptRetainedTerminalHistory(session: HeldSession, replace: boolean): void {
  const held = session.retainedTerminalHistory
  if (!held) {
    return
  }
  session.retainedTerminalHistory = undefined
  if (replace && held.painted) {
    session.writeReplayData(CLEAR_HELD_SCREEN)
  }
  if (replace) {
    held.prepareFresh?.()
  }
  session.pane.terminal.options.disableStdin = false
}

export function captureTerminalHistoryReadOwner(session: ConnectPanePtySession): void {
  session.terminalHistoryReadOwner = {
    environmentId: session.runtimeEnvironmentId,
    pairingRevision: session.runtimeEnvironmentId
      ? getRuntimeEnvironmentRevision(session.runtimeEnvironmentId)
      : undefined
  }
}

function localHistoryDestination(session: ConnectPanePtySession) {
  const state = useAppStore.getState()
  const worktreeId: string = session.deps.worktreeId
  const tabId = resolveTerminalTabId(state, session.deps.tabId)
  const leafId: string = session.pane.leafId
  const layout = state.terminalLayoutsByTabId[tabId]
  const hint: string | undefined = session.deps.restoredPtyIdByLeafId?.[leafId]
  const executionHostId = normalizeExecutionHostId(session.executionHostId)
  const owner = resolveTerminalPaneOwnerContext(
    state,
    worktreeId,
    tabId,
    executionHostId
      ? resolveWorktreeOperationRouteForHost(state, worktreeId, executionHostId)
      : null
  )
  const tab = owner.tab
  if (
    !tab ||
    owner.unresolved ||
    owner.runtimeEnvironmentId ||
    owner.executionHostId !== executionHostId ||
    (tab.generation ?? 0) !== (session.tabGeneration ?? 0) ||
    state.getTerminalTabOwnerWorktreeId?.(tabId) !== worktreeId ||
    hasClosedTerminalTabRecord(state.closedTerminalTabTombstonesByTabId, tabId, worktreeId) ||
    (layout?.root ? !collectLeafIds(layout.root).includes(leafId) : !hint)
  ) {
    return null
  }
  const binding = layout?.ptyIdsByLeafId?.[leafId]
  if (binding && hint && binding !== hint) {
    return null
  }
  const sessionId = hint ?? binding ?? (layout?.root?.type === 'leaf' ? tab.ptyId : null) ?? null
  const retained = state.terminalPaneStartsByPaneKey[`${tabId}:${leafId}`]?.retainedTerminalStart
  if (
    !sessionId &&
    (owner.executionHostId !== 'local' ||
      !retained ||
      retained.executionHostId !== owner.executionHostId ||
      retained.worktreeId !== worktreeId ||
      retained.tabId !== tabId ||
      retained.leafId !== leafId)
  ) {
    return null
  }
  return {
    tabId,
    sessionId,
    identity: JSON.stringify([
      owner.executionHostId,
      worktreeId,
      tabId,
      leafId,
      tab.generation ?? 0,
      Boolean(layout?.root),
      binding ?? null,
      sessionId,
      retained ? [retained.runtimeId, retained.startSequence, retained.bindingGeneration] : null
    ])
  }
}

/** Read only this saved pane on its captured runtime; absent/older hosts leave existing pixels alone. */
export function readSavedTerminalHistory(session: ConnectPanePtySession): Promise<void> {
  const owner = session.terminalHistoryReadOwner
  if (
    !owner ||
    session.disposed ||
    session.transport.getPtyId() ||
    session.terminalOwnerUnresolved
  ) {
    return Promise.resolve()
  }
  const executionHostId = normalizeExecutionHostId(session.executionHostId)
  if (!owner.environmentId && !executionHostId) {
    return Promise.resolve()
  }
  const pane = parsePaneKey(toHostSessionPaneKey(session.cacheKey))
  if (!pane || pane.leafId !== session.pane.leafId) {
    return Promise.resolve()
  }
  const destination = !owner.environmentId ? localHistoryDestination(session) : null
  if (!owner.environmentId && !destination) {
    return Promise.resolve()
  }
  const sessionId =
    destination?.sessionId ?? session.deps.restoredPtyIdByLeafId?.[pane.leafId] ?? null
  const held = holdRetainedTerminalHistory(session, sessionId)
  const generation = session.transportStreamGeneration
  const readIdentity = JSON.stringify([
    owner.environmentId,
    executionHostId,
    session.deps.worktreeId,
    pane.tabId,
    pane.leafId,
    generation,
    destination?.identity ?? sessionId
  ])
  if (held.readIdentity !== readIdentity) {
    held.readIdentity = readIdentity
    held.reading = undefined
  }
  held.painted ||=
    session.deps.restoredViewportBlankingPanesRef?.current.has(session.pane.id) === true
  if (held.painted) {
    return Promise.resolve()
  }
  if (held.reading) {
    return held.reading
  }
  const transport = session.transport
  const ownerIsCurrent = (): boolean =>
    !owner.environmentId ||
    (owner.pairingRevision !== undefined &&
      resolveContinuedRuntimeEnvironmentRevision(owner.environmentId, owner.pairingRevision) ===
        getRuntimeEnvironmentRevision(owner.environmentId))
  const isCurrent = (): boolean =>
    !session.disposed &&
    !session.terminalOwnerUnresolved &&
    session.runtimeEnvironmentId === owner.environmentId &&
    normalizeExecutionHostId(session.executionHostId) === executionHostId &&
    ownerIsCurrent() &&
    (!destination || localHistoryDestination(session)?.identity === destination.identity) &&
    generation === session.transportStreamGeneration &&
    session.retainedTerminalHistory === held &&
    held.readIdentity === readIdentity &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === transport &&
    !transport.getPtyId()
  const read = async (): Promise<void> => {
    if (!isCurrent()) {
      return
    }
    let proof
    if (owner.environmentId) {
      if (owner.pairingRevision === undefined) {
        return
      }
      proof = await runtimeEnvironmentCapabilityProof(
        owner.environmentId,
        SESSION_TERMINAL_HISTORY_READ_RUNTIME_CAPABILITY,
        3000
      )
      const continuedRevision = resolveContinuedRuntimeEnvironmentRevision(
        owner.environmentId,
        owner.pairingRevision
      )
      if (
        !proof.supported ||
        proof.pairingRevision !== continuedRevision ||
        getRuntimeEnvironmentRevision(owner.environmentId) !== continuedRevision ||
        !isCurrent()
      ) {
        return
      }
    }
    const result = await callRuntimeRpc<SessionReadTerminalHistoryResult>(
      owner.environmentId
        ? { kind: 'environment', environmentId: owner.environmentId }
        : { kind: 'local' },
      'session.readTerminalHistory',
      {
        worktreeId: session.deps.worktreeId,
        tabId: destination?.tabId ?? pane.tabId,
        leafId: pane.leafId,
        ...(!owner.environmentId
          ? { executionHostId, ...(sessionId ? { expectedSessionId: sessionId } : {}) }
          : {})
      },
      {
        timeoutMs: 3000,
        suppressFeatureInteraction: true,
        expectedEnvironmentPairingRevision: proof?.pairingRevision,
        expectedEnvironmentRuntimeId: proof?.runtimeId
      }
    )
    if (result.status === 'restored' && isCurrent()) {
      const dimensions = resolvePositiveTerminalDimensions(result.cols, result.rows)
      if (
        dimensions &&
        (session.pane.terminal.cols !== dimensions.cols ||
          session.pane.terminal.rows !== dimensions.rows)
      ) {
        session.suppressStructuralReplayPtyResize = true
        try {
          session.pane.terminal.resize(dimensions.cols, dimensions.rows)
        } finally {
          session.suppressStructuralReplayPtyResize = false
        }
      }
      if (!isCurrent()) {
        return
      }
      held.painted = true
      session.writeReplayData(result.scrollback)
    }
  }
  const reading = read()
    .catch(() => {})
    .finally(() => {
      if (held.reading === reading) {
        held.reading = undefined
      }
    })
  held.reading = reading
  return reading
}
