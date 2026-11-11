// Wait for main’s terminal start and attach, or show its failure; the window cannot spawn a replacement.

import { useAppStore } from '@/store/index'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { recordPtyConnectDiagnostic } from '../instrumentation/pty-connect-diagnostics'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { resolveTerminalTabId } from '../terminal-tab-id'
import {
  findWslDistroHoldInText,
  wslDistroHoldUserMessage
} from '../../../../../../shared/wsl-distro-stopped-hold'
import { holdPaneForStoppedWslDistro } from '../../session-restore/wsl-distro/wsl-distro-stopped-hold-state'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { readSavedTerminalHistory } from '../reattach/retained-terminal-history'
import type { PendingStartupCommand, FreshSpawnOptions } from '../startup/fresh-spawn-types'
import type { TerminalPaneStart } from '@/store/terminals/terminal-state'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'

type PaneStartWait = {
  connects: Set<() => void>
  failed: Set<() => void>
  allowSavedBinding: boolean
}

const waiting = new WeakMap<ConnectPanePtySession, PaneStartWait>()
// A pane's stopped-distro card, cleared when main's start of it ends.
const heldCards = new WeakMap<ConnectPanePtySession, () => void>()

/** The starts this gate waits on; a sleeping or held pane starts on its first view (C1c). */
const gated = (start: TerminalPaneStart | undefined): boolean =>
  start?.status === 'starting' ||
  start?.status === 'resuming' ||
  start?.status === 'failed' ||
  (start?.status === 'held' && start.retainedTerminalStart !== undefined)

type PaneStartState = ReturnType<typeof useAppStore.getState>

function pendingStart(
  session: ConnectPanePtySession,
  state: PaneStartState
): TerminalPaneStart | undefined {
  const start = state.terminalPaneStartsByPaneKey[session.cacheKey]
  return (ORCA_LAYOUT_OWNER_IS_MAIN || start?.retainedTerminalStart) &&
    !(start?.retainedTerminalStart && session.userRestart) &&
    gated(start)
    ? start
    : undefined
}

function waitsForStartupRestoration(
  session: ConnectPanePtySession,
  allowSavedBinding: boolean,
  state: PaneStartState
): boolean {
  if (
    session.userRestart ||
    session.runtimeEnvironmentId ||
    runtimeEnvironmentIdUnlessTwin(state, session.deps.worktreeId)
  ) {
    return false
  }
  const leafId = session.pane.leafId
  const tabId = resolveTerminalTabId(state, session.deps.tabId)
  if (!state.terminalStartupAttempt?.isUnknown(session.deps.worktreeId, tabId, leafId)) {
    return false
  }
  const savedBinding =
    state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ||
    (session.deps.restoredLeafId === leafId && session.deps.restoredPtyIdByLeafId?.[leafId])
  return !allowSavedBinding || !savedBinding
}

export function hasUnknownRestoredPaneStart(session: ConnectPanePtySession): boolean {
  return waitsForStartupRestoration(session, false, useAppStore.getState())
}

/** Call connect after main’s start ends, or onFailed on its published failure. */
export function waitsForMainPaneStart(
  session: ConnectPanePtySession,
  connect: () => void,
  onFailed?: () => void,
  // An absent attach is no longer evidence for the saved binding's liveness.
  allowSavedBinding = true
): boolean {
  const state = useAppStore.getState()
  const start = pendingStart(session, state)
  if (!start && !waitsForStartupRestoration(session, allowSavedBinding, state)) {
    if (allowSavedBinding && !session.userRestart && hasUnknownRestoredPaneStart(session)) {
      adoptMainBinding(session, state)
    }
    return false
  }
  const joined = waiting.get(session)
  if (joined) {
    joined.allowSavedBinding &&= allowSavedBinding
    joined.connects.add(connect)
    if (onFailed) {
      joined.failed.add(onFailed)
      if (start?.status === 'failed' || start?.status === 'held') {
        onFailed()
      }
    }
    return true
  }
  const wait: PaneStartWait = { connects: new Set([connect]), failed: new Set(), allowSavedBinding }
  if (onFailed) {
    wait.failed.add(onFailed)
  }
  waiting.set(session, wait)
  recordPtyConnectDiagnostic(
    `pane=${session.pane.id} -> WAIT FOR MAIN START (${start?.status ?? 'startup unknown'})`
  )
  let shown = start
  const showFailure = (): void => {
    if ((shown?.status === 'failed' || shown?.status === 'held') && !session.disposed) {
      showPaneStartFailure(session, shown.reason)
      for (const failed of wait.failed) {
        failed()
      }
    }
  }
  showFailure()
  const unsubscribe = useAppStore.subscribe((state) => {
    const next = pendingStart(session, state)
    if (next) {
      if (next !== shown) {
        shown = next
        showFailure()
      }
      return
    }
    shown = undefined
    if (waitsForStartupRestoration(session, wait.allowSavedBinding, state)) {
      return
    }
    // Main's start ended: the pane is bound to its terminal now, or main took it back.
    heldCards.get(session)?.()
    heldCards.delete(session)
    adoptMainBinding(session, state)
    unsubscribe()
    waiting.delete(session)
    const index = session.waitTeardowns.indexOf(unsubscribe)
    if (index !== -1) {
      session.waitTeardowns.splice(index, 1)
    }
    if (!session.disposed) {
      for (const waiter of wait.connects) {
        waiter()
      }
    }
  })
  session.waitTeardowns.push(unsubscribe)
  return true
}

/** The terminal main bound the pane to, as the pane's restore id: the connect then attaches it. */
export function adoptMainBinding(
  session: ConnectPanePtySession,
  state: ReturnType<typeof useAppStore.getState>
): void {
  const tabId = resolveTerminalTabId(state, session.deps.tabId)
  const leafId = session.pane.leafId
  const ptyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  if (ptyId) {
    session.deps.restoredLeafId = leafId
    session.deps.restoredPtyIdByLeafId = { ...session.deps.restoredPtyIdByLeafId, [leafId]: ptyId }
  }
}

/** The one place a pane shows why main's start of it failed (copy the owner approved). */
export function showPaneStartFailure(
  session: ConnectPanePtySession,
  reason: string | undefined
): void {
  void readSavedTerminalHistory(session)
  // Main publishes the code; an RPC refusal carries the sentence instead.
  const hold = reason ? (findWslDistroHoldInText(reason)?.hold ?? null) : null
  if (hold && !session.disposed && !session.runtimeEnvironmentId) {
    // Main held background work on a stopped (or unchecked) distro: the card's Start asks main to start it.
    const state = useAppStore.getState()
    const pane = {
      worktreeId: session.deps.worktreeId,
      tabId: resolveTerminalTabId(state, session.deps.tabId),
      leafId: session.pane.leafId
    }
    heldCards.get(session)?.()
    const forget = holdPaneForStoppedWslDistro(session.cacheKey, {
      ...hold,
      release: () =>
        callRuntimeRpc({ kind: 'local' }, 'layout.startWslHeldPanes', { panes: [pane] })
    })
    heldCards.set(session, forget)
    session.waitTeardowns.push(forget)
    return
  }
  if (!session.disposed) {
    session.deps.onPtyErrorRef?.current?.(
      session.pane.id,
      // A paired host's held pane has no local Start: the sentence, which the banner localizes.
      hold
        ? wslDistroHoldUserMessage(hold)
        : `The terminal could not start: ${reason ?? 'unknown error'}`
    )
  }
}

export function waitForFreshPaneStart(
  session: ConnectPanePtySession,
  startupOverride: PendingStartupCommand | null | undefined,
  options: FreshSpawnOptions
): Promise<string | null> | undefined {
  const waiting = Promise.withResolvers<string | null>()
  let waitSettled = false
  const settleWait = (): void => {
    waitSettled = true
    waiting.resolve(null)
  }
  if (
    waitsForMainPaneStart(
      session,
      () => {
        if (!waitSettled) {
          waitSettled = true
          waiting.resolve(session.startFreshSpawn(startupOverride, options))
        }
      },
      settleWait,
      false
    )
  ) {
    session.waitTeardowns.push(settleWait)
    return waiting.promise
  }
  return undefined
}
