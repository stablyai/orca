import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PtyTransport } from '../../pty-transport-types'
import { useWslHostUnavailableReason } from '../../../../../runtime/hosts/wsl/wsl-host-availability'
import {
  useManagedPairingRefusedEnvironmentId,
  useManagedServerReplaced
} from './use-managed-pairing-refused'
import { CalmRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'
import { useRetryingOutageEnvironmentId } from '../../recovery/server-outage/remote-server-outage'
import { useWorkspaceRuntimeEnvironmentId } from '../../../../../lib/workspace/ownership/workspace-runtime-environment'
import {
  usePublishRemoteServerNoticeShowing,
  useRemoteServerNoticeClaim
} from '../../recovery/server-outage/remote-server-notice-claims'
import { RemoteServerOutageNotice } from '../../recovery/server-outage/RemoteServerOutageNotice'
import { WslHostStoppedCard } from '../../recovery/wsl/WslHostStoppedCard'
import { useRetryPanesWhenWslHostReturns } from '../../recovery/wsl/use-wsl-host-return-retry'
import { useCalmStatusReveal } from '@/hooks/use-calm-status-reveal'
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
import { paneShowsWslHostStoppedCard } from '@/runtime/hosts/wsl/wsl-host-stopped-status'
import { withoutWslHostStoppedLines } from '../../../../../../../shared/wsl-host-stopped-message'
import { makePaneKey } from '../../../../../../../shared/workspace-layout/stable-pane-id'
import { cloudWokeActionFor, runCloudWokeAction } from '@/lib/orca-cloud/cloud-wake-hint-action'
import { captureCloudPaneBeforeWake } from '@/lib/orca-cloud/cloud-wake-pane-capture'
import { useIsWorktreeGoingToSleep } from '@/lib/worktree-sleep-view'
import { armWakeScrollback, forgetWakeScrollback } from '@/lib/orca-cloud/cloud-wake-scrollback'
import { listenForWakeScroll } from '@/lib/orca-cloud/cloud-wake-scroll-listener'
import { restartPaneExists } from '@/lib/orca-cloud/cloud-agent-restart-pane-watch'
import { mapPaneTerminalErrors } from '../../../errors/terminal-error-accumulation'
import type { TerminalPaneController } from '../../../controller/use-terminal-pane-controller'

/** Reconnect pairs refused servers, signs in SSH hosts awaiting credentials, or otherwise retries the pane. */
export function createPaneRecoveryReconnect(
  getTransport: () => PtyTransport | undefined,
  pairingRefusedEnvironmentId: string | null,
  awaitingSignIn = false
): () => void {
  return () => {
    const retry = (): void => {
      getTransport()?.retryRecovery?.()
    }
    // Why connect first: it asks Orca to pair again, which a pane retry alone does not.
    if (pairingRefusedEnvironmentId) {
      void window.api.runtimeEnvironments
        .connect({ selector: pairingRefusedEnvironmentId })
        .catch(() => undefined)
        .finally(retry)
      return
    }
    const signInEnvironmentId = awaitingSignIn ? getTransport()?.getRuntimeEnvironmentId?.() : null
    if (signInEnvironmentId) {
      // Do not retry rejected sign-in into another prompt; successful control-ready revival starts the pane.
      void window.api.runtimeEnvironments
        .connect({ selector: signInEnvironmentId })
        .then((response) => {
          if (response.ok) {
            retry()
          }
        })
        .catch(() => undefined)
      return
    }
    retry()
  }
}

export function TerminalPaneRecoveryPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    managedPanes,
    paneTransportsRef,
    ptyRecoveryStatesByPaneId,
    showSshReconnectOverlay,
    tabId
  } = controller
  const wslHostUnavailable = useWslHostUnavailableReason(controller.worktreeId)
  const pairingRefusedEnvironmentId = useManagedPairingRefusedEnvironmentId(controller.worktreeId)
  const serverReplaced = useManagedServerReplaced(pairingRefusedEnvironmentId)
  // Why Settings, not Connect: SSH access alone can't pair with the host's new server key.
  const openReplacedServerSettings = useCallback(() => {
    if (!pairingRefusedEnvironmentId) {
      return
    }
    const state = useAppStore.getState()
    state.openSettingsTarget({
      pane: 'servers',
      repoId: null,
      sectionId: pairingRefusedEnvironmentId
    })
    state.openSettingsPage()
  }, [pairingRefusedEnvironmentId])
  const ownerEnvironmentId = useWorkspaceRuntimeEnvironmentId(controller.worktreeId)
  // One subscription for both the card and the retry: one listener per mounted surface.
  const ownerWslHost = useAppStore((state) =>
    ownerEnvironmentId ? state.wslHostStatuses[ownerEnvironmentId] : undefined
  )
  const stoppedWslDistro = ownerWslHost?.state === 'distro-stopped' ? ownerWslHost.distro : null
  const { setTerminalError, setTerminalErrorsByPaneId } = controller
  const ownerWslDistro = ownerWslHost?.distro ?? null
  // Why scoped to this host's distro: a pane on another, still-stopped host keeps its line.
  const clearStoppedHostErrors = useCallback(() => {
    if (!ownerWslDistro) {
      return
    }
    const strip = (error: string): string | null =>
      withoutWslHostStoppedLines(error, ownerWslDistro)
    setTerminalError((current) => (current === null ? null : strip(current)))
    setTerminalErrorsByPaneId((current) => mapPaneTerminalErrors(current, strip))
  }, [ownerWslDistro, setTerminalError, setTerminalErrorsByPaneId])
  useRetryPanesWhenWslHostReturns(
    ownerEnvironmentId,
    ownerWslHost?.state,
    paneTransportsRef,
    clearStoppedHostErrors
  )
  const retryingOutageEnvironmentId = useRetryingOutageEnvironmentId(controller.worktreeId)
  // An Orca Cloud workspace mid-wake already shows its waking pill; "Reconnecting" would be noise.
  const cloud = useCloudRecoveryContext(controller.worktreeId)
  const cloudWaking = cloud?.waking === true
  const cloudAsleep = cloud?.asleep === true
  const cloudAwake = cloud !== null && !cloudWaking && !cloudAsleep
  useWakeProcessHintsVersion()
  // While asleep (or waking) the pane still holds the pre-sleep scrollback: note what was running,
  // so after the wake the pane can say it stopped and offer it back (JA-15).
  const isCloud = cloud !== null
  const asleepSince = cloud?.asleepSince ?? null
  // Sleep was asked for: look now, before the transport's resubscribes (while the VM suspends)
  // replace the pane's buffer with the host's 1000-row snapshot (WAKE-SCROLLBACK).
  const goingToSleep = useIsWorktreeGoingToSleep(controller.worktreeId)
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
  // WAKE-SCROLLBACK: a person scrolling the pane while it sleeps or wakes keeps that place after the
  // restore, across the wake's remount. Wheel only: writes also scroll, and must not count.
  useEffect(() => {
    if (!isCloud || !(cloudAsleep || cloudWaking)) {
      return
    }
    return listenForWakeScroll(managedPanes)
  }, [isCloud, cloudAsleep, cloudWaking, managedPanes])
  // A pane closed, or its tab or workspace went away: drop its kept pre-sleep output.
  const leafIdsRef = useRef<(typeof managedPanes)[number]['leafId'][]>([])
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
  const isolated = controller.isolatedPaneKey !== null
  // Why: a pane waiting for SSH sign-in says so itself; "reconnecting" over it would be false.
  const awaitingSignInHere = managedPanes.some(
    (pane) => ptyRecoveryStatesByPaneId[pane.id]?.reason === 'ssh-sign-in'
  )
  // Why not isolated panes: an Activity thread shows one pane away from this tab's surface.
  const canSpeak =
    controller.isVisible &&
    !isolated &&
    !showSshReconnectOverlay &&
    !awaitingSignInHere &&
    !wslHostUnavailable &&
    // Why: "retrying automatically" would be false; each pane offers Start instead.
    stoppedWslDistro === null &&
    pairingRefusedEnvironmentId === null &&
    !cloudWaking &&
    !cloudAsleep &&
    // SLEEP-RECONNECT-BANNER: a sleep the person asked for drops the connection on purpose.
    !goingToSleep
  const serverDown = retryingOutageEnvironmentId !== null
  const notice = useRemoteServerNoticeClaim(ownerEnvironmentId, serverDown, canSpeak)
  const [noticeEnvironmentId, setNoticeEnvironmentId] = useState<string | null>(null)
  if (notice.speaks && ownerEnvironmentId !== noticeEnvironmentId) {
    setNoticeEnvironmentId(ownerEnvironmentId)
  }
  const revealed = useCalmStatusReveal(notice.speaks, false, notice.since)
  // Hold only on the eligible outage leader; hidden/sign-in/WSL surfaces and handoffs must not overlap another notice or card.
  const [handedOff, setHandedOff] = useState(false)
  if (notice.speaks && handedOff) {
    setHandedOff(false)
  } else if (!notice.speaks && serverDown && revealed.visible && !handedOff) {
    setHandedOff(true)
  }
  const noticeReveal =
    canSpeak && !handedOff && (notice.speaks || !serverDown)
      ? revealed
      : { visible: false, downSince: null }
  usePublishRemoteServerNoticeShowing(noticeEnvironmentId, noticeReveal.visible)
  if (showSshReconnectOverlay) {
    return null
  }
  return (
    <>
      {noticeEnvironmentId ? (
        <RemoteServerOutageNotice
          key={noticeEnvironmentId}
          environmentId={noticeEnvironmentId}
          reveal={noticeReveal}
          cloudWorkspaceName={cloud?.workspaceName ?? null}
        />
      ) : null}
      {managedPanes.map((pane) => {
        const recoveryState = ptyRecoveryStatesByPaneId[pane.id]
        const awaitingSignIn = recoveryState?.reason === 'ssh-sign-in'
        const transport = paneTransportsRef.current.get(pane.id)
        // Why only when unknown: a bridged pane reports null on purpose and must not borrow the owner's server.
        const paneEnvironmentId = transport?.getRuntimeEnvironmentId
          ? transport.getRuntimeEnvironmentId()
          : ownerEnvironmentId
        const onReconnect = createPaneRecoveryReconnect(
          () => paneTransportsRef.current.get(pane.id),
          pairingRefusedEnvironmentId,
          awaitingSignIn
        )
        // Why with or without a recovery: a stopped distro's pane is dead either way, and only Start revives it.
        if (
          stoppedWslDistro !== null &&
          ownerEnvironmentId !== null &&
          paneShowsWslHostStoppedCard({
            wslHostUnavailable: wslHostUnavailable !== null,
            stoppedWslDistro,
            ownerEnvironmentId,
            paneEnvironmentId
          })
        ) {
          return createPortal(
            <WslHostStoppedCard
              environmentId={ownerEnvironmentId}
              distro={stoppedWslDistro}
              onStarted={onReconnect}
            />,
            pane.container,
            `wsl-host-stopped-${pane.id}`
          )
        }
        // Asleep: nothing to reconnect to; one calm line with Wake instead of a reconnect card (RA-12).
        if (cloudAsleep) {
          return createPortal(
            <CloudAsleepTerminalNotice
              workspaceId={controller.worktreeId}
              asleepSince={cloud?.asleepSince ?? null}
              historyEndPx={historyEndOffsetPx(pane.terminal, pane.container)}
            />,
            pane.container,
            `cloud-asleep-${pane.id}`
          )
        }
        // Waking: the pre-sleep scrollback is still there and must not read as live (JA-15).
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
        // An agent pane: the host relaunches its agent; Restart only if that never comes (RA-WAKE).
        if (wokeHint && 'restartAgent' in wokeHint) {
          const wokeAction = cloudWokeActionFor(wokeHint)
          const paneKey = makePaneKey(tabId, pane.leafId)
          // CHAT-BANNERS: an open chat view shows this one (Restart only); the Rerun notice stays here.
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
        // Why mounted with no recovery: the banner's minimum time and hold outlive the recovery itself.
        return createPortal(
          <CalmRemoteRuntimeReconnectBanner
            // Why per pane, not per epoch: a Reconnect click opens a new epoch and must not hide the banner again.
            key={`remote-runtime-reconnect-${pane.id}`}
            recovery={recoveryState && recoveryState.reason !== 'ownership' ? recoveryState : null}
            environmentId={paneEnvironmentId}
            // Why stopped panes too: a card flashing over the notice's hold is the overlap this avoids.
            heldByServer={
              cloudWaking ||
              goingToSleep ||
              // ASLEEP-RECONNECT-BANNER: asleep on purpose, so not a dropped connection.
              cloudAsleep ||
              (!isolated &&
                !awaitingSignIn &&
                !wslHostUnavailable &&
                pairingRefusedEnvironmentId === null &&
                notice.quiet &&
                paneEnvironmentId === ownerEnvironmentId)
            }
            cloudWorkspaceName={cloud?.workspaceName ?? null}
            onReconnect={onReconnect}
            wslHostUnavailable={wslHostUnavailable}
            pairingRefused={pairingRefusedEnvironmentId !== null}
            onOpenReplacedServerSettings={serverReplaced ? openReplacedServerSettings : null}
            awaitingSignIn={awaitingSignIn}
          />,
          pane.container,
          `remote-runtime-reconnect-${pane.id}`
        )
      })}
    </>
  )
}
