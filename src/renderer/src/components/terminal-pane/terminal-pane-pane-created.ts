import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { PaneSpawnHints } from '@/lib/pane-manager/pane-manager-types'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createOsc52OscHandler } from './osc52-clipboard'
import {
  showOsc52ClipboardBlockedToast,
  showOsc52ClipboardFailedToast
} from './osc52-clipboard-toast'
import { parseOsc7 } from './parse-osc7'
import { mergePaneCwdFromOsc7, settlePaneCwdDeferredSpawn } from './resolve-split-cwd'
import {
  appendDeferredSplitPaneInput,
  beginDeferredSplitPaneHandoff,
  claimDeferredSplitPaneHandoff,
  clearDeferredSplitPaneHandoff,
  discardDeferredSplitPaneHandoffForKey,
  type DeferredSplitPaneHandoffHandle
} from './deferred-split-pane-handoff'
import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'
import { guardParserHandler } from './terminal-parser-handler-guard'
import { isPaneReplaying } from './replay-guard'
import { connectPanePty } from './pty-connection'
import {
  createQueuedStartupConsumer,
  resolvePaneSeedCwd,
  clearQueuedInitialCwdAfterFirstPane
} from './terminal-pane-lifecycle-primitives'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'
import { installTerminalPaneLinkHandling } from './terminal-pane-pane-links'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'

export type PaneCreatedSetupContext = TerminalPaneManagerOptionsContext

/** Creates the PaneManager `onPaneCreated` callback. */
export function createTerminalPaneCreatedHandler(
  context: PaneCreatedSetupContext
): (pane: ManagedPane, spawnHints?: PaneSpawnHints) => void {
  // Split spawn hints let the renderer pane appear before a slow inherited-cwd lookup finishes.
  return (pane, spawnHints) => {
    const { deps, refs, ptyDeps, startupWithSetupSplitWait, startup, osc7UncHost } = context
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    const { settingsRef, paneCwdRef, paneKittyKeyboardModesRef, replayingPanesRef, managerRef } =
      deps
    const { deferredSplitHandoffs } = context
    const paneKey = makePaneKey(deps.tabId, pane.leafId)
    const restoredPtyId = ptyDeps.restoredPtyIdByLeafId?.[pane.leafId]
    const hasAuthoritativeSpawnHint = Boolean(spawnHints?.cwd || spawnHints?.ptyId || restoredPtyId)
    let effectiveSpawnHints = spawnHints
    let claimedDeferredSplitHandoff: ReturnType<typeof claimDeferredSplitPaneHandoff> = null
    let deferredSplitHandoff: DeferredSplitPaneHandoffHandle | undefined
    if (spawnHints?.cwdPromise && !hasAuthoritativeSpawnHint) {
      deferredSplitHandoff = beginDeferredSplitPaneHandoff(paneKey, spawnHints.cwdPromise)
      deferredSplitHandoffs.set(pane.id, deferredSplitHandoff)
    } else if (!hasAuthoritativeSpawnHint) {
      claimedDeferredSplitHandoff = claimDeferredSplitPaneHandoff(paneKey)
      if (claimedDeferredSplitHandoff) {
        deferredSplitHandoff = claimedDeferredSplitHandoff.handle
        deferredSplitHandoffs.set(pane.id, deferredSplitHandoff)
        effectiveSpawnHints = {
          ...spawnHints,
          cwdPromise: claimedDeferredSplitHandoff.cwdPromise
        }
      }
    } else {
      // A restored PTY or explicit spawn hint is authoritative; an older
      // deferred record must not be claimed by a later remount.
      discardDeferredSplitPaneHandoffForKey(paneKey)
    }
    const handoffForInput = deferredSplitHandoff

    const osc52Disposable = pane.terminal.parser.registerOscHandler(
      52,
      guardParserHandler(
        'osc-52-clipboard',
        createOsc52OscHandler({
          getSettingEnabled: () => settingsRef.current?.terminalAllowOsc52Clipboard,
          getReplaying: () => isPaneReplaying(replayingPanesRef, pane.id),
          writeClipboardText: (text) => window.api.ui.writeTerminalClipboardText(text),
          showBlockedWriteToast: showOsc52ClipboardBlockedToast,
          showWriteFailedToast: showOsc52ClipboardFailedToast
        })
      )
    )
    refs.osc52DisposablesRef.current.set(pane.id, osc52Disposable)

    const existingPaneCwd = paneCwdRef.current.get(pane.id)
    if (!existingPaneCwd) {
      paneCwdRef.current.set(pane.id, {
        cwd: resolvePaneSeedCwd(effectiveSpawnHints?.cwd, ptyDeps.cwd ?? ''),
        confirmed: false,
        ...(effectiveSpawnHints?.cwdPromise
          ? {
              deferredSplitSpawn: true,
              pendingCwd: effectiveSpawnHints.cwdPromise
            }
          : {})
      })
    } else if (effectiveSpawnHints?.cwdPromise && !existingPaneCwd.confirmed) {
      paneCwdRef.current.set(pane.id, {
        ...existingPaneCwd,
        deferredSplitSpawn: true,
        pendingCwd: effectiveSpawnHints.cwdPromise
      })
    }
    if (effectiveSpawnHints?.cwdPromise) {
      const cwdPromise = effectiveSpawnHints.cwdPromise
      // A rejected lookup keeps the seed cwd; either way the settled identity
      // stays until bind/failure so a stale cleanup cannot clear a newer lookup.
      const applySettledCwd = (cwd: string | null): void => {
        const current = paneCwdRef.current.get(pane.id)
        if (!current || current.confirmed || current.pendingCwd !== cwdPromise) {
          return
        }
        paneCwdRef.current.set(pane.id, {
          cwd: cwd ?? current.cwd,
          confirmed: false,
          ...(current.deferredSplitSpawn ? { deferredSplitSpawn: true } : {}),
          pendingCwd: cwdPromise
        })
      }
      void cwdPromise.then(applySettledCwd, () => applySettledCwd(null))
    }
    const osc7Disposable = pane.terminal.parser.registerOscHandler(
      7,
      guardParserHandler('osc-7-cwd', (data) => {
        const parsedCwd = parseOsc7(data, { uncHost: osc7UncHost })
        if (parsedCwd) {
          const confirmed = !isPaneReplaying(replayingPanesRef, pane.id)
          paneCwdRef.current.set(
            pane.id,
            mergePaneCwdFromOsc7(paneCwdRef.current.get(pane.id), parsedCwd, confirmed)
          )
        }
        return true
      })
    )
    refs.osc7DisposablesRef.current.set(pane.id, osc7Disposable)

    installTerminalPaneInputHandling({
      pane,
      managerRef,
      paneKittyKeyboardModesRef,
      settingsRef,
      imeCompositionDisposablesRef: refs.imeCompositionDisposablesRef,
      imeNativeTextForwarderDisposablesRef: refs.imeNativeTextForwarderDisposablesRef
    })
    installTerminalPaneLinkHandling({
      pane,
      managerRef,
      settingsRef,
      refs,
      linkDeps: context.linkDeps,
      fileOpenLinkHint: context.fileOpenLinkHint,
      requestOpenLinksInAppPreference: context.requestOpenLinksInAppPreference,
      getHttpLinkSourceOwnerForPane: context.getHttpLinkSourceOwnerForPane,
      getHttpLinkActionDestinations: context.getHttpLinkActionDestinations,
      getLinkActionContext: context.getLinkActionContext,
      getPaneLinkCwd: context.getPaneLinkCwd,
      getUrlOpenLinkHint: context.getUrlOpenLinkHint,
      onShowSessionRestoredBanner: context.onShowSessionRestoredBanner,
      ptyStartup: ptyDeps.startup
    })

    context.applyAppearance(manager)
    const onQueuedStartupSpawned = createQueuedStartupConsumer(
      ptyDeps.startup,
      startupWithSetupSplitWait,
      () => useAppStore.getState().consumeTabStartupCommand(deps.tabId),
      () => useAppStore.getState().pendingStartupByTabId[deps.tabId] === startup
    )
    const panePtyBinding = connectPanePty(pane, manager, {
      ...ptyDeps,
      ...(onQueuedStartupSpawned ? { onQueuedStartupSpawned } : {}),
      ...(effectiveSpawnHints?.cwdPromise
        ? {
            onDeferredCwdSpawnFailed: () => {
              settlePaneCwdDeferredSpawn(
                paneCwdRef.current,
                pane.id,
                effectiveSpawnHints.cwdPromise
              )
              if (handoffForInput) {
                clearDeferredSplitPaneHandoff(handoffForInput)
                deferredSplitHandoffs.delete(pane.id)
              }
            }
          }
        : {}),
      ...(handoffForInput
        ? {
            onPreconnectInput: (input: PtyPreconnectInputEntry) =>
              appendDeferredSplitPaneInput(handoffForInput, input)
          }
        : {}),
      ...(claimedDeferredSplitHandoff?.preconnectInput.length
        ? { preconnectInput: claimedDeferredSplitHandoff.preconnectInput }
        : {}),
      ...(effectiveSpawnHints?.cwd ? { cwd: effectiveSpawnHints.cwd } : {}),
      ...(effectiveSpawnHints?.cwdPromise ? { cwdPromise: effectiveSpawnHints.cwdPromise } : {}),
      restoredPtyIdByLeafId: effectiveSpawnHints?.ptyId
        ? {
            ...ptyDeps.restoredPtyIdByLeafId,
            [pane.leafId]: effectiveSpawnHints.ptyId
          }
        : ptyDeps.restoredPtyIdByLeafId,
      restoredLeafId: pane.leafId
    })
    ptyDeps.startup = null
    const nextInitialCwdState = clearQueuedInitialCwdAfterFirstPane(
      refs.queuedInitialCwdRef.current,
      context.defaultTabCwd,
      ptyDeps.cwd ?? ''
    )
    refs.queuedInitialCwdRef.current = nextInitialCwdState.queuedInitialCwd
    ptyDeps.cwd = nextInitialCwdState.ptyCwd
    deps.panePtyBindingsRef.current.set(pane.id, panePtyBinding)
    context.syncPaneCount()
    scheduleRuntimeGraphSync()
    context.queueResizeAll(true)
  }
}
