import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { PtyTransport } from './pty-transport-types'
import { useWslHostUnavailableReason } from './use-wsl-host-unavailable-reason'
import { useManagedPairingRefusedEnvironmentId } from './use-managed-pairing-refused'
import { CalmRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'
import {
  useRetryingOutageEnvironmentId,
  useWorkspaceRuntimeEnvironmentId
} from './remote-server-outage'
import {
  usePublishRemoteServerNoticeShowing,
  useRemoteServerNoticeClaim
} from './remote-server-notice-claims'
import { RemoteServerOutageNotice } from './RemoteServerOutageNotice'
import { WslHostStoppedCard } from './WslHostStoppedCard'
import { useCalmStatusReveal } from '@/hooks/use-calm-status-reveal'
import { useAppStore } from '@/store'
import { paneShowsWslHostStoppedCard, selectStoppedWslDistro } from '@/lib/wsl-host-stopped-status'
import type { TerminalPaneController } from './use-terminal-pane-controller'

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
  const { managedPanes, paneTransportsRef, ptyRecoveryStatesByPaneId, showSshReconnectOverlay } =
    controller
  const wslHostUnavailable = useWslHostUnavailableReason(controller.worktreeId)
  const pairingRefusedEnvironmentId = useManagedPairingRefusedEnvironmentId(controller.worktreeId)
  const ownerEnvironmentId = useWorkspaceRuntimeEnvironmentId(controller.worktreeId)
  const stoppedWslDistro = useAppStore((state) => selectStoppedWslDistro(state, ownerEnvironmentId))
  const retryingOutageEnvironmentId = useRetryingOutageEnvironmentId(controller.worktreeId)
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
    pairingRefusedEnvironmentId === null
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
        // Why mounted with no recovery: the banner's minimum time and hold outlive the recovery itself.
        return createPortal(
          <CalmRemoteRuntimeReconnectBanner
            // Why per pane, not per epoch: a Reconnect click opens a new epoch and must not hide the banner again.
            key={`remote-runtime-reconnect-${pane.id}`}
            recovery={recoveryState && recoveryState.reason !== 'ownership' ? recoveryState : null}
            environmentId={paneEnvironmentId}
            // Why stopped panes too: a card flashing over the notice's hold is the overlap this avoids.
            heldByServer={
              !isolated &&
              !awaitingSignIn &&
              !wslHostUnavailable &&
              pairingRefusedEnvironmentId === null &&
              notice.quiet &&
              paneEnvironmentId === ownerEnvironmentId
            }
            onReconnect={onReconnect}
            wslHostUnavailable={wslHostUnavailable}
            pairingRefused={pairingRefusedEnvironmentId !== null}
            awaitingSignIn={awaitingSignIn}
          />,
          pane.container,
          `remote-runtime-reconnect-${pane.id}`
        )
      })}
    </>
  )
}
