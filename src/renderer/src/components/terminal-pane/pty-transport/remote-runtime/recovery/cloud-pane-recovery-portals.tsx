import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store/index'
import { useCloudRecoveryContext } from '@/lib/orca-cloud/use-cloud-recovery-context'
import { CloudAsleepTerminalNotice } from '@/components/orca-cloud/offline/CloudAsleepTerminalNotice'
import { CloudWokeProcessesNotice } from '@/components/orca-cloud/offline/CloudWokeProcessesNotice'
import { CloudWokeAgentNotice } from '@/components/orca-cloud/offline/CloudWokeAgentNotice'
import { CloudPaneBannerPortal } from '@/components/agent-sign-in-strip/CloudPaneBannerPortal'
import {
  dismissWakeProcessHint,
  endsAtShellPrompt,
  getWakeCaptureTime,
  getWakeProcessHint,
  historyEndOffsetPx,
  readTerminalTail,
  resetWakeProcessCapture,
  wakeShowsStaleHistory,
  useWakeProcessHintsVersion
} from '@/lib/orca-cloud/cloud-wake-process-hints'
import { makePaneKey } from '../../../../../../../shared/workspace-layout/stable-pane-id'
import { cloudWokeActionFor, runCloudWokeAction } from '@/lib/orca-cloud/cloud-wake-hint-action'
import { captureCloudPaneBeforeWake } from '@/lib/orca-cloud/cloud-wake-pane-capture'
import {
  clearDeliberateCloudStop,
  useIsDeliberateCloudStopHeld,
  useIsWorktreeGoingToSleep
} from '@/lib/worktree-sleep-view'
import { armWakeScrollback, forgetWakeScrollback } from '@/lib/orca-cloud/cloud-wake-scrollback'
import { listenForWakeScroll } from '@/lib/orca-cloud/cloud-wake-scroll-listener'
import { restartPaneExists } from '@/lib/orca-cloud/cloud-agent-restart-pane-watch'
import type { TerminalPaneController } from '../../../controller/use-terminal-pane-controller'

type ManagedPane = TerminalPaneController['managedPanes'][number]

export type CloudPaneRecovery = {
  /** Mid-wake, asleep, or stopping on purpose: the drop is expected, so no reconnect notice or card. */
  holdsReconnect: boolean
  workspaceName: string | null
  /** The pane's cloud sleep/wake notice, when one replaces the reconnect banner. */
  renderPanePortal: (pane: ManagedPane) => React.ReactNode | null
}

/** Orca Cloud sleep/wake state for a terminal surface's recovery portals. */
export function useCloudPaneRecovery(controller: TerminalPaneController): CloudPaneRecovery {
  const { managedPanes, paneTransportsRef, tabId } = controller
  // An Orca Cloud workspace mid-wake already shows its waking pill; "Reconnecting" would be noise.
  const cloud = useCloudRecoveryContext(controller.worktreeId)
  const cloudWaking = cloud?.waking === true
  const cloudAsleep = cloud?.asleep === true
  const cloudAwake = cloud !== null && !cloudWaking && !cloudAsleep
  useWakeProcessHintsVersion()
  // While asleep (or waking) the pane still holds the pre-sleep scrollback: note what was running,
  // so after the wake the pane can say it stopped and offer it back.
  const isCloud = cloud !== null
  const asleepSince = cloud?.asleepSince ?? null
  // Sleep was asked for: look now, before the transport's resubscribes (while the VM suspends)
  // replace the pane's buffer with the host's 1000-row snapshot.
  // A Sleep or Archive the person chose, until a wake starts (or the hold runs out): its dropped
  // streams are on purpose, so no "Reattaching terminal" while the status catches up.
  const deliberateStop = useIsDeliberateCloudStopHeld(controller.worktreeId)
  const goingToSleep = useIsWorktreeGoingToSleep(controller.worktreeId)
  const stoppingOnPurpose = goingToSleep || deliberateStop
  useEffect(() => {
    if (deliberateStop && cloudWaking) {
      clearDeliberateCloudStop(controller.worktreeId)
    }
  }, [deliberateStop, cloudWaking, controller.worktreeId])
  // Set once the workspace was asleep this cycle: only then is a replay the woken terminal's.
  const sleptRef = useRef(false)
  useEffect(() => {
    if (!isCloud) {
      return
    }
    // Never while waking: a remount may already hold restored copies; the capture is the sleep's.
    if (goingToSleep || cloudAsleep) {
      for (const pane of managedPanes) {
        // The Rerun hint and the pre-sleep output, before the new terminal attaches.
        captureCloudPaneBeforeWake({
          tabId,
          leafId: pane.leafId,
          worktreeId: controller.worktreeId,
          terminal: pane.terminal,
          asleepSince
        })
      }
    } else {
      resetWakeProcessCapture(managedPanes.map((pane) => pane.leafId))
    }
    if (cloudAsleep) {
      sleptRef.current = true
    } else if (sleptRef.current && (cloudWaking || cloudAwake)) {
      // Waking or live after a sleep: the next clearing replay is the woken terminal's.
      armWakeScrollback(managedPanes.map((pane) => pane.leafId))
      if (cloudAwake) {
        sleptRef.current = false
      }
    }
  }, [
    isCloud,
    goingToSleep,
    cloudAsleep,
    cloudWaking,
    cloudAwake,
    managedPanes,
    tabId,
    controller.worktreeId,
    asleepSince
  ])
  // A person scrolling the pane while it sleeps or wakes keeps that place after the
  // restore, across the wake's remount. Wheel only: writes also scroll, and must not count.
  useEffect(() => {
    if (!isCloud || !(cloudAsleep || cloudWaking)) {
      return
    }
    return listenForWakeScroll(managedPanes)
  }, [isCloud, cloudAsleep, cloudWaking, managedPanes])
  // A pane closed, or its tab or workspace went away: drop its kept pre-sleep output.
  const leafIdsRef = useRef<ManagedPane['leafId'][]>([])
  useEffect(() => {
    const now = managedPanes.map((pane) => pane.leafId)
    forgetWakeScrollback(leafIdsRef.current.filter((id) => !now.includes(id)))
    leafIdsRef.current = now
  }, [managedPanes])
  useEffect(
    () => () => {
      const state = useAppStore.getState()
      forgetWakeScrollback(
        leafIdsRef.current.filter((id) => !restartPaneExists(state, makePaneKey(tabId, id)))
      )
    },
    [tabId]
  )

  const renderPanePortal = (pane: ManagedPane): React.ReactNode | null => {
    // Asleep: nothing to reconnect to; one calm line with Wake instead of a reconnect card.
    if (cloudAsleep) {
      return createPortal(
        <CloudAsleepTerminalNotice
          workspaceId={controller.worktreeId}
          asleepSince={cloud?.asleepSince ?? null}
          archived={cloud?.archived === true}
          historyEndPx={historyEndOffsetPx(pane.terminal, pane.container)}
        />,
        pane.container,
        `cloud-asleep-${pane.id}`
      )
    }
    // Waking: the pre-sleep scrollback is still there and must not read as live.
    if (cloudWaking && wakeShowsStaleHistory(pane.leafId)) {
      return createPortal(
        <CloudAsleepTerminalNotice
          workspaceId={controller.worktreeId}
          asleepSince={cloud?.asleepSince ?? null}
          historyEndPx={historyEndOffsetPx(pane.terminal, pane.container)}
          waking
        />,
        pane.container,
        `cloud-waking-history-${pane.id}`
      )
    }
    // Up again after a sleep: the process that was running is gone; say so once, never rerun it.
    const wokeHint = cloudAwake ? getWakeProcessHint(pane.leafId) : null
    // An agent pane: the host relaunches its agent; Restart only if that never comes.
    if (wokeHint && 'restartAgent' in wokeHint) {
      const wokeAction = cloudWokeActionFor(wokeHint)
      const paneKey = makePaneKey(tabId, pane.leafId)
      // An open chat view shows this one (Restart only); the Rerun notice stays here.
      return (
        <CloudPaneBannerPortal
          key={pane.id}
          pane={pane}
          paneKey={paneKey}
          portalKey={`cloud-woke-${pane.id}`}
        >
          <CloudWokeAgentNotice
            paneKey={paneKey}
            paneLeafId={pane.leafId}
            agentName={wokeAction.kind === 'restart' ? wokeAction.agent : ''}
            capturedAt={getWakeCaptureTime(pane.leafId) ?? 0}
            paneAtShellPrompt={() => endsAtShellPrompt(readTerminalTail(pane.terminal, 40))}
            subscribeScreen={(onChange) => {
              const subscription = pane.terminal.onWriteParsed(onChange)
              return () => subscription.dispose()
            }}
            onRestart={() => {
              dismissWakeProcessHint(pane.leafId)
              runCloudWokeAction(wokeHint, {
                tabId,
                leafId: pane.leafId,
                worktreeId: controller.worktreeId,
                sendInput: () => undefined
              })
            }}
            onDismiss={() => dismissWakeProcessHint(pane.leafId)}
          />
        </CloudPaneBannerPortal>
      )
    }
    if (wokeHint) {
      return createPortal(
        <CloudWokeProcessesNotice
          action={cloudWokeActionFor(wokeHint)}
          paneLeafId={pane.leafId}
          onAction={() => {
            dismissWakeProcessHint(pane.leafId)
            runCloudWokeAction(wokeHint, {
              tabId,
              leafId: pane.leafId,
              worktreeId: controller.worktreeId,
              sendInput: (data) =>
                paneTransportsRef.current.get(pane.id)?.sendInput(data, 'driving')
            })
          }}
          onDismiss={() => dismissWakeProcessHint(pane.leafId)}
        />,
        pane.container,
        `cloud-woke-${pane.id}`
      )
    }
    return null
  }

  return {
    // A sleep the person asked for drops the connection on purpose.
    holdsReconnect: cloudWaking || cloudAsleep || stoppingOnPurpose,
    workspaceName: cloud?.workspaceName ?? null,
    renderPanePortal
  }
}
