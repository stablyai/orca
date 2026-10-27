import { useAppStore } from '@/store'
import type { PtyPaneStartup } from '../pty-connection-types'
import type { PtyTransport } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { findTerminalTabForPane } from './terminal-tab-id'
import { isPaneOwnerRefusal } from './pane-owner-recovery'
import {
  sessionRestartCatchResult,
  type AgentSessionRestartSpawnResult
} from '@/lib/agent-session-restart-verdict'

type RefusalCallbacks = Parameters<NonNullable<PtyTransport['attach']>>[0]['callbacks']

type RefusalReattachSession = {
  disposed: boolean
  transportStreamGeneration: number
  tabGeneration: number
  cols: number
  rows: number
  pane: { leafId: string }
  deps: { tabId: string; worktreeId: string }
  transport: {
    getPtyId: () => string | null
    attach?: PtyTransport['attach']
  }
  bindActivePanePty: (ptyId: string, options?: { replacePtyId?: string }) => boolean
}

/**
 * A typed pre-stop refusal reattaches the predecessor with this session's callbacks.
 * The failed attempt created no process. Never kill whatever id the transport now has.
 */
export function reattachRefusedSessionRestart(
  session: RefusalReattachSession,
  error: unknown,
  callbacks: RefusalCallbacks,
  generation: number,
  predecessorPtyId: string | null
): AgentSessionRestartSpawnResult | null {
  const refusal = sessionRestartCatchResult(error)
  if (!refusal || !predecessorPtyId) {
    return null
  }
  const tab = findTerminalTabForPane(
    useAppStore.getState(),
    session.deps.worktreeId,
    session.deps.tabId
  )
  const leafPty =
    useAppStore.getState().terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[
      session.pane.leafId
    ]
  const current =
    !session.disposed &&
    generation === session.transportStreamGeneration &&
    tab !== null &&
    (tab.generation ?? 0) === session.tabGeneration &&
    (!leafPty || leafPty === predecessorPtyId)
  const owned = session.transport.getPtyId()
  if (!current || (owned !== null && owned !== predecessorPtyId)) {
    return null
  }
  session.transport.attach?.({
    existingPtyId: predecessorPtyId,
    cols: session.cols,
    rows: session.rows,
    callbacks
  })
  session.bindActivePanePty(predecessorPtyId, { replacePtyId: predecessorPtyId })
  // The restart suppressed this pty's exit; it is live again, so its real exit must surface.
  useAppStore.getState().consumeSuppressedPtyExit(predecessorPtyId)
  return refusal
}

/** Spawn failure cleanup, then a typed pre-stop reattach. Other failures stay unrestored. */
export function finishFailedFreshSpawn(args: {
  session: ConnectPanePtySession
  error: unknown
  ownerRefused: boolean
  callbacks: { callbacks: RefusalCallbacks; generation: number }
  predecessorPtyId: string | null
  releaseDeferredCwdFence: () => void
  clearPreSignaledSerializer: () => void
  notify: (result: AgentSessionRestartSpawnResult | null) => void
  launchStartup: PtyPaneStartup
  startupOverride: object | null | undefined
}): null {
  const message = args.error instanceof Error ? args.error.message : String(args.error)
  if (!args.ownerRefused && isPaneOwnerRefusal(message)) {
    args.callbacks.callbacks.onError?.(message)
  }
  args.releaseDeferredCwdFence()
  args.session.finishReattachLiveDataDeferral(false, args.callbacks.generation)
  if (
    args.session.paneStartup?.launchConfig ||
    (args.startupOverride !== null &&
      args.startupOverride !== undefined &&
      'launchConfig' in args.startupOverride)
  ) {
    args.session.clearRegisteredStartupLaunchConfig(args.launchStartup)
  }
  args.clearPreSignaledSerializer()
  args.notify(
    reattachRefusedSessionRestart(
      {
        disposed: Boolean(args.session.disposed),
        transportStreamGeneration: Number(args.session.transportStreamGeneration),
        tabGeneration: Number(args.session.tabGeneration),
        cols: Number(args.session.cols),
        rows: Number(args.session.rows),
        pane: { leafId: args.session.pane.leafId },
        deps: { tabId: args.session.deps.tabId, worktreeId: args.session.deps.worktreeId },
        transport: args.session.transport,
        bindActivePanePty: (ptyId, options) =>
          Boolean(args.session.bindActivePanePty(ptyId, options))
      },
      args.error,
      args.callbacks.callbacks,
      args.callbacks.generation,
      args.predecessorPtyId
    )
  )
  return null
}
