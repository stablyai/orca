// RA-11: the strip over an Orca Cloud pane whose agent is already running when its Orca-account
// sign-in expires. Same component, place and height as #315's pre-launch strip; the terminal keeps
// running and refits below it, so its scrollback stays readable and selectable.
import type React from 'react'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { useAgentSignInGate } from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import { cloudTabHoldKey, useCloudAgentHold } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  orcaCloudAgentAccountsLoadedAt,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  clearCloudRunningSignout,
  cloudRunningStrip,
  useCloudRunningAccountReads,
  useCloudRunningSignoutVersion,
  useWorkspaceUsesAccount
} from '@/lib/orca-cloud/cloud-running-agent-signout'
import {
  cloudAgentRestartAttempt,
  cloudAgentRestartStartedFresh,
  dismissCloudAgentRestart,
  settleCloudAgentRestart
} from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import {
  CloudAgentSignInStrip,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import { CloudPaneBannerPortal } from './CloudPaneBannerPortal'
import { startCloudPaneAgentRestart } from '@/lib/orca-cloud/cloud-pane-agent-restart'
import {
  cloudRestartAttemptModel,
  cloudRestartFreshModel,
  cloudRunningStripModel
} from './cloud-running-strip-model'
import { openOrcaCloudAccountsSettings, withRenewInPlace } from './cloud-renew-in-place'

const NO_ACTIONS: CloudStripActions = {
  primary: () => undefined,
  submitCode: () => undefined,
  pasteCode: () => undefined,
  useCode: () => undefined,
  useApiKey: () => undefined,
  cancel: () => undefined
}

export function CloudRunningStripPortal({
  pane,
  tabId,
  worktreeId
}: {
  pane: ManagedPane
  tabId: string
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const paneKey = makePaneKey(tabId, pane.leafId)
  const revision = useCloudRunningSignoutVersion()
  const ptyId = useAppStore(
    (state) => state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? null
  )
  const environmentId = useAppStore(
    (state) =>
      (ptyId ? parseRemoteRuntimePtyId(ptyId)?.environmentId : null) ??
      runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  )
  const cloud = environmentId !== null && isOrcaCloudEnvironmentId(environmentId)
  const entry = useAppStore((state) =>
    cloud ? (state.agentStatusByPaneKey[paneKey] ?? null) : null
  )
  const running = cloud && (entry?.agentType === 'claude' || entry?.agentType === 'codex')
  useCloudRunningAccountReads(running)
  const accounts = useOrcaCloudAgentAccounts(running)
  const agentType = entry?.agentType
  const agent: HostAgentSignInAgent | null =
    agentType === 'claude' ? 'claude' : agentType === 'codex' ? 'codex' : null
  // D13: only a workspace that runs the agent on the person's own account (never shared or keyed).
  const expired =
    agent !== null &&
    accounts.load.kind === 'ready' &&
    accounts.load.status.credentials[agent].state !== 'active' &&
    accounts.load.status.credentials[agent].state !== 'expiring' &&
    accounts.load.status.credentials[agent].state !== 'none'
  const usesAccount = useWorkspaceUsesAccount(
    running ? environmentId : null,
    agent,
    expired,
    orcaCloudAgentAccountsLoadedAt()
  )
  // DUP-EXPIRED-STRIP: a host-published launch holds its whole tab (cloudTabHoldKey); its strip
  // is the one to show, never this one stacked beside it.
  const paneHold = useCloudAgentHold(paneKey)
  const tabHold = useCloudAgentHold(cloudTabHoldKey(tabId))
  const hold = paneHold ?? tabHold
  const gate = useAgentSignInGate(paneKey)
  const held = hold !== null || gate !== null
  const attempt = cloudAgentRestartAttempt(paneKey, revision)
  // Success needs proof: the pane is bound to a new PTY after the relaunch was asked for (the old
  // agent's terminal was replaced). Anything less turns into "Couldn't restart" at the timeout.
  const launched = attempt?.phase === 'restarting' && attempt.launchedAt !== null
  const attemptPtyId = attempt?.ptyId ?? null
  useEffect(() => {
    if (launched && ptyId !== null && ptyId !== attemptPtyId) {
      settleCloudAgentRestart(paneKey)
    }
  }, [paneKey, launched, ptyId, attemptPtyId])
  const restart = (args: { agent: HostAgentSignInAgent; resumable: boolean }): void => {
    if (!ptyId) {
      return
    }
    // The pane's own session resumes when it has one.
    startCloudPaneAgentRestart({ paneKey, worktreeId, ptyId, ...args })
  }
  // RA-11e: a resume that found no conversation started fresh; say so for a moment, then clear.
  if (cloud && cloudAgentRestartStartedFresh(paneKey, revision)) {
    return (
      <CloudPaneBannerPortal
        pane={pane}
        paneKey={paneKey}
        portalKey={`cloud-running-strip-${pane.id}`}
        stripLayer
      >
        <CloudAgentSignInStrip
          model={cloudRestartFreshModel(agent ?? 'claude', t)}
          prompt={null}
          width={cloudStripWidth(pane.container.clientWidth)}
          actions={NO_ACTIONS}
        />
      </CloudPaneBannerPortal>
    )
  }
  // A Restart in flight (or failed) owns the strip even while the pane has no agent status.
  if (attempt && cloud) {
    const attemptActions: CloudStripActions = {
      primary: (action) => {
        if (action.kind === 'restart' && attempt.phase === 'failed') {
          restart({ agent: attempt.agent, resumable: attempt.resumable })
        }
      },
      submitCode: () => undefined,
      pasteCode: () => undefined,
      useCode: () => undefined,
      useApiKey: () => undefined,
      cancel: () => (attempt.phase === 'failed' ? dismissCloudAgentRestart(paneKey) : undefined)
    }
    return (
      <CloudPaneBannerPortal
        pane={pane}
        paneKey={paneKey}
        portalKey={`cloud-running-strip-${pane.id}`}
        stripLayer
      >
        <CloudAgentSignInStrip
          model={cloudRestartAttemptModel(attempt, t)}
          prompt={null}
          width={cloudStripWidth(pane.container.clientWidth)}
          actions={attemptActions}
        />
      </CloudPaneBannerPortal>
    )
  }
  if (!running) {
    return null
  }
  // The read that showed the renewal dates it (a pure read, never the render clock).
  const strip = cloudRunningStrip({
    paneKey,
    entry,
    accounts,
    held,
    now: orcaCloudAgentAccountsLoadedAt(),
    usesAccount,
    revision
  })
  if (!strip) {
    return null
  }
  const actions: CloudStripActions = {
    primary: (action) => {
      if (action.kind === 'renew') {
        openOrcaCloudAccountsSettings()
      } else if (action.kind === 'restart' && strip.phase === 'renewed') {
        restart({ agent: strip.agent, resumable: strip.resumable })
      }
    },
    submitCode: () => undefined,
    pasteCode: () => undefined,
    useCode: () => undefined,
    useApiKey: () => undefined,
    // State 2's ×; state 1 has none (Renew is the action) and Escape leaves it showing.
    cancel: () => (strip.phase === 'renewed' ? clearCloudRunningSignout(paneKey) : undefined)
  }
  // CHAT-RENEW-INPLACE: "sign-in expired · Renew" renews right here; renewed keeps RA-11's Restart.
  const model = cloudRunningStripModel(strip, t)
  const shown =
    strip.phase === 'expired'
      ? withRenewInPlace({
          agent: strip.agent,
          setup: accounts.setups[strip.agent],
          model,
          actions,
          key: paneKey,
          t
        })
      : { model, actions }
  return (
    <CloudPaneBannerPortal
      pane={pane}
      paneKey={paneKey}
      portalKey={`cloud-running-strip-${pane.id}`}
      stripLayer
    >
      <CloudAgentSignInStrip
        model={shown.model}
        prompt={null}
        width={cloudStripWidth(pane.container.clientWidth)}
        actions={shown.actions}
      />
    </CloudPaneBannerPortal>
  )
}
