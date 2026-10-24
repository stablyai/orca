// Layout-owner build: a pane with no live terminal is started by main, never by the window. The
// window asks, waits for main's start to end, then attaches to the terminal main bound.

import { useAppStore } from '@/store'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import {
  adoptMainBinding,
  showPaneStartFailure,
  waitsForMainPaneStart
} from './main-pane-start-wait'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { mainStartsPane } from './main-starts-pane'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

type MainPaneStartHandlers = {
  /** Runs once main's start for the pane ends: the pane is bound to its terminal. */
  attach: () => void
  /** Main handed a twin's start back: start it as today. */
  today?: () => void
  /** Main refused the start, or showed it failed. */
  refused?: () => void
}

/**
 * Asks main to start the pane, then attaches once main's start for it ends. False when main does
 * not own the pane's layout (a paired server's workspace), which keeps today's path.
 */
export function startPaneThroughMain(
  session: ConnectPanePtySession,
  handlers: MainPaneStartHandlers
): boolean {
  const tabId = parsePaneKey(session.cacheKey)?.tabId
  if (!tabId) {
    return false
  }
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> START THROUGH MAIN`)
  const refused = (code: string): void => {
    showPaneStartFailure(session, code)
    handlers.refused?.()
  }
  return sendLayoutApply(
    useAppStore.getState(),
    session.deps.worktreeId,
    { type: 'startPane', tabId, paneKey: session.cacheKey },
    {
      // Main's reply lands after the frame that shows the pane starting, or bound when it was live.
      apply: () => {
        if (session.disposed || waitsForMainPaneStart(session, handlers.attach, handlers.refused)) {
          return
        }
        adoptMainBinding(session, useAppStore.getState())
        handlers.attach()
      },
      asToday: handlers.today ?? (() => refused('host_not_owned')),
      refused
    }
  )
}

/**
 * Layout-owner build: the window's own start of a pane (a wake, a hibernated agent's wake, a
 * restart replacement, a reattach that found its terminal gone) asks main instead, then attaches
 * to the terminal main bound. `today` starts it when main does not start this pane.
 */
export function startPaneThroughMainThenAttach(
  session: ConnectPanePtySession,
  today: () => Promise<string | null>
): Promise<string | null> {
  if (!mainStartsPane(session)) {
    return today()
  }
  if (session.mainStartAttach) {
    // Why main's own code: the attach to main's start found no terminal; asking again would loop on a pane
    // whose terminal ends at once.
    showPaneStartFailure(session, 'terminal_not_started')
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const settleNull = (): void => resolve(null)
    session.waitTeardowns.push(settleNull)
    const sent = startPaneThroughMain(session, {
      attach: () => {
        const ptyId = session.deps.restoredPtyIdByLeafId?.[session.pane.leafId] ?? null
        if (ptyId) {
          // Main started a fresh terminal: follow its output, as a window start does.
          session.resetFreshSpawnFollowOutput()
          startDeferredSessionReattach(session, ptyId, { afterMainStart: true })
        }
        resolve(ptyId)
      },
      today: () => {
        session.mainPaneStartHandedBack = true
        resolve(today())
      },
      refused: settleNull
    })
    if (!sent) {
      resolve(today())
    }
  })
}

/**
 * Layout-owner build, at connect: whether main's start of the pane (under way, or one this view
 * asks for) stands in for the window's own. A sleeping pane is started on its first view; a held
 * pane attaches as today, and main's refusal holds it. `connect` attaches after.
 */
export function defersToMainPaneStart(
  session: ConnectPanePtySession,
  connect: () => void
): boolean {
  if (waitsForMainPaneStart(session, connect)) {
    return true
  }
  if (!mainStartsPane(session)) {
    return false
  }
  if (useAppStore.getState().terminalPaneStartsByPaneKey[session.cacheKey]?.status !== 'sleeping') {
    return false
  }
  const startOnView = (): void => {
    session.mainPaneStartOnReveal = null
    const today = (): void => {
      session.mainPaneStartHandedBack = true
      connect()
    }
    // Why re-armed on a refusal: a failed call is retried by the pane's next view.
    const refused = (): void => {
      session.mainPaneStartOnReveal = startOnView
    }
    if (!startPaneThroughMain(session, { attach: connect, today, refused })) {
      today()
    }
  }
  if (session.deps.isVisibleRef.current) {
    startOnView()
  } else {
    // Why: a hidden pane waits for its first view, as a hidden sleeping agent does (#29459).
    session.mainPaneStartOnReveal = startOnView
  }
  return true
}
