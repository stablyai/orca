import { Fragment, useCallback } from 'react'
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
  useRemoteServerNoticeClaim,
  useReportRemoteServerPaneRetries
} from '../../recovery/server-outage/remote-server-notice-claims'
import { usePublishRemoteServerDownTab } from '../../recovery/server-outage/remote-server-outage-signals'
import { RemoteServerPaneVeil } from '../../recovery/server-outage/RemoteServerPaneVeil'
import { WslHostStoppedCard } from '../../recovery/wsl/WslHostStoppedCard'
import { useRetryPanesWhenWslHostReturns } from '../../recovery/wsl/use-wsl-host-return-retry'
import { useAppStore } from '@/store/index'
import { paneShowsWslHostStoppedCard } from '@/runtime/hosts/wsl/wsl-host-stopped-status'
import { withoutWslHostStoppedLines } from '../../../../../../../shared/remote-runtime/wsl-hosts/wsl-host-stopped-message'
import { mapPaneTerminalErrors } from '../../../errors/terminal-error-accumulation'
import type { TerminalPaneController } from '../../../controller/use-terminal-pane-controller'
import { classifyRemoteServerPaneRetries } from '../../recovery/server-outage/remote-server-pane-retries'

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
  // Why these panes only: sign-in, WSL, pairing and Activity panes explain themselves, and bridged panes are on another server.
  const surfaceHeldByServer =
    !isolated &&
    !wslHostUnavailable &&
    stoppedWslDistro === null &&
    pairingRefusedEnvironmentId === null
  const paneEnvironmentIds = managedPanes.map((pane) => {
    const transport = paneTransportsRef.current.get(pane.id)
    // Why only when unknown: a bridged pane reports null on purpose and must not borrow the owner's server.
    return transport?.getRuntimeEnvironmentId
      ? transport.getRuntimeEnvironmentId()
      : ownerEnvironmentId
  })
  const serverPanes = managedPanes.filter(
    (pane, index) =>
      surfaceHeldByServer &&
      paneEnvironmentIds[index] === ownerEnvironmentId &&
      ptyRecoveryStatesByPaneId[pane.id]?.reason !== 'ssh-sign-in'
  )
  useReportRemoteServerPaneRetries(
    serverDown ? ownerEnvironmentId : null,
    serverDown
      ? classifyRemoteServerPaneRetries(
          serverPanes.map((pane) => ptyRecoveryStatesByPaneId[pane.id])
        )
      : null
  )
  // Why gated on the card: a veil must never appear without the card that explains it.
  const veilServerPanes = serverDown && notice.showing && !showSshReconnectOverlay
  usePublishRemoteServerDownTab(
    controller.tabId,
    serverDown && !showSshReconnectOverlay && serverPanes.length > 0
  )
  if (showSshReconnectOverlay) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane, index) => {
        const recoveryState = ptyRecoveryStatesByPaneId[pane.id]
        const awaitingSignIn = recoveryState?.reason === 'ssh-sign-in'
        const paneEnvironmentId = paneEnvironmentIds[index]
        const onReconnect = (): void => {
          createPaneRecoveryReconnect(
            () => paneTransportsRef.current.get(pane.id),
            pairingRefusedEnvironmentId,
            awaitingSignIn
          )()
        }
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
        const veil =
          veilServerPanes && ownerEnvironmentId !== null && serverPanes.includes(pane)
            ? createPortal(
                <RemoteServerPaneVeil
                  environmentId={ownerEnvironmentId}
                  terminal={pane.terminal}
                />,
                pane.container,
                `remote-server-pane-veil-${pane.id}`
              )
            : null
        // Why mounted with no recovery: the banner's minimum time and hold outlive the recovery itself.
        const banner = createPortal(
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
            onOpenReplacedServerSettings={serverReplaced ? openReplacedServerSettings : null}
            awaitingSignIn={awaitingSignIn}
          />,
          pane.container,
          `remote-runtime-reconnect-${pane.id}`
        )
        // Why one keyed fragment: the banner keeps its reveal clock while the veil comes and goes.
        return (
          <Fragment key={`pane-recovery-${pane.id}`}>
            {veil}
            {banner}
          </Fragment>
        )
      })}
    </>
  )
}
