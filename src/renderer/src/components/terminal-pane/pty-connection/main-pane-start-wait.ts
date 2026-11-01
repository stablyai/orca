// Wait for main’s terminal start and attach, or show its failure; the window cannot spawn a replacement.

import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { PaneStartStatus } from '../../../../../shared/workspace-layout/workspace-layout-published'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { resolveTerminalTabId } from './terminal-tab-id'
import { parseWslDistroHold } from '../../../../../shared/wsl-distro-stopped-hold'
import { holdPaneForStoppedWslDistro } from '../wsl-distro-stopped-hold-state'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

type PaneStartWait = { connects: Set<() => void>; failed: Set<() => void> }

const waiting = new WeakMap<ConnectPanePtySession, PaneStartWait>()
// A pane's stopped-distro card, cleared when main's start of it ends.
const heldCards = new WeakMap<ConnectPanePtySession, () => void>()

/** The starts this gate waits on; a sleeping or held pane starts on its first view (C1c). */
const gated = (status: PaneStartStatus | undefined): boolean =>
  status === 'starting' || status === 'resuming' || status === 'failed'

/** Call connect after main’s start ends, or onFailed on its published failure. */
export function waitsForMainPaneStart(
  session: ConnectPanePtySession,
  connect: () => void,
  onFailed?: () => void
): boolean {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return false
  }
  const start = useAppStore.getState().terminalPaneStartsByPaneKey[session.cacheKey]
  if (!start || !gated(start.status)) {
    return false
  }
  const joined = waiting.get(session)
  if (joined) {
    joined.connects.add(connect)
    if (onFailed) {
      joined.failed.add(onFailed)
      if (start.status === 'failed') {
        onFailed()
      }
    }
    return true
  }
  const wait: PaneStartWait = { connects: new Set([connect]), failed: new Set() }
  if (onFailed) {
    wait.failed.add(onFailed)
  }
  waiting.set(session, wait)
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> WAIT FOR MAIN START (${start.status})`)
  let shown = start
  const showFailure = (): void => {
    if (shown.status === 'failed' && !session.disposed) {
      showPaneStartFailure(session, shown.reason)
      for (const failed of wait.failed) {
        failed()
      }
    }
  }
  showFailure()
  const unsubscribe = useAppStore.subscribe((state) => {
    const found = state.terminalPaneStartsByPaneKey[session.cacheKey]
    const next = found && gated(found.status) ? found : undefined
    if (next === shown) {
      return
    }
    if (next) {
      shown = next
      showFailure()
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
  const hold = reason ? parseWslDistroHold(reason) : null
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
      `The terminal could not start: ${reason ?? 'unknown error'}`
    )
  }
}
