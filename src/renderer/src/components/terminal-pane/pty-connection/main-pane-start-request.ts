// Ask layout-owner main to start, wait for its bound terminal, then attach without a window-owned spawn.

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

/** Ask main and attach after its start; false preserves paired-server ownership for the caller. */
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

/** Delegate window-initiated wake/restart/missing-reattach starts to main; today handles panes outside main’s ownership. */
export function startPaneThroughMainThenAttach(
  session: ConnectPanePtySession,
  today: () => Promise<string | null>
): Promise<string | null> {
  if (!mainStartsPane(session)) {
    return today()
  }
  if (session.mainStartAttach) {
    // Do not retry main’s own attach-missing verdict; immediate terminal death would otherwise loop starts.
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

/** Replace window starts with main-owned starts; sleeping panes wait for first view, while held panes attach and honor refusal. */
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
