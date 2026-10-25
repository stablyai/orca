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
import { useCalmStatusReveal } from '@/hooks/use-calm-status-reveal'
import type { TerminalPaneController } from './use-terminal-pane-controller'

/**
 * What a pane's Reconnect does: pair again first when the server refused us, sign in first when
 * the SSH host waits for it, and otherwise retry the pane.
 */
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
      // Why no retry on failure: a rejected password must not re-dial into a second prompt;
      // the control-ready revival starts the pane once sign-in succeeds.
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
    pairingRefusedEnvironmentId === null
  const serverDown = retryingOutageEnvironmentId !== null
  const notice = useRemoteServerNoticeClaim(ownerEnvironmentId, serverDown, canSpeak)
  const [noticeEnvironmentId, setNoticeEnvironmentId] = useState<string | null>(null)
  if (notice.speaks && ownerEnvironmentId !== noticeEnvironmentId) {
    setNoticeEnvironmentId(ownerEnvironmentId)
  }
  const revealed = useCalmStatusReveal(notice.speaks, false, notice.since)
  // Why gated on canSpeak: the hold is for a server that answered, not for a surface that lost its
  // turn (hidden, sign-in, WSL), whose own cards must not land under a lingering notice.
  // Why: a surface that lost the lead while the server is still down handed its notice to
  // another; only the leader when the outage ends may hold, so a handoff never shows two.
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
            onReconnect={createPaneRecoveryReconnect(
              () => paneTransportsRef.current.get(pane.id),
              pairingRefusedEnvironmentId,
              awaitingSignIn
            )}
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
