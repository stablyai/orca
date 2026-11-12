// The panel on hosts that keep their own login. Section 1 asks the host once per open while it can
// answer; sections 2–3 read only this computer (Agent API keys, the recipe env summary).
import React, { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RecipeForwardedEnvSummary } from '../../../../shared/ephemeral-vm-recipe-forwarded-env'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import { HostAgentSignOutDialog } from '../sidebar/worktree-list/rows/HostAgentSignOutMenuItems'
import { formatDate } from '../settings/agent-accounts/orca-cloud-account-row-shell'
import { RecipeEnvForwardingWarning } from './RecipeEnvForwardingWarning'
import type { AgentHostCapabilities } from './agent-host-capabilities'
import { HostAgentsPanelSection } from './HostAgentsPanelSection'
import { agentApiKeysForHost, hostAgentPanelRows } from './host-agents-panel-model'
import { openAgentHostSettings } from './open-agent-host-settings'
import type { ResolvedAgentHost } from './use-agent-host'
import { useHostAgentReport } from './use-host-agent-report'
import { wslSelectedAccounts } from './wsl-selected-account'
import { useAppStore } from '@/store'
import { isWslHostRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { useSshClassicAgents } from './ssh-classic/use-ssh-classic-agents'
import { SshSignOutDialog } from './ssh-classic/SshSignOutDialog'
import {
  cancelSshAgentSignIn,
  startSshAgentSignIn,
  submitSshAgentSignInCode
} from '@/lib/ssh-agent-sign-in/ssh-agent-sign-in-store'

function useHostKeys(hostId: ExecutionHostId): AgentApiKeySummary[] | null {
  const [keys, setKeys] = useState<AgentApiKeySummary[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void (window.api.agentApiKeys?.list() ?? Promise.resolve(null))
      .catch(() => null)
      .then((state) => {
        if (!cancelled) {
          setKeys(state ? agentApiKeysForHost(state.keys, hostId) : [])
        }
      })
    return () => {
      cancelled = true
    }
  }, [hostId])
  return keys
}

/** Main resolves this recipe host's passEnv from its recipe; the renderer only names the host. */
function useRecipeEnvSummary(
  enabled: boolean,
  environmentId: string | null
): RecipeForwardedEnvSummary | null | undefined {
  const [summary, setSummary] = useState<RecipeForwardedEnvSummary | null | undefined>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void (
      window.api.ephemeralVm?.forwardedEnvSummary(environmentId ? { environmentId } : undefined) ??
      Promise.resolve(undefined)
    )
      .catch(() => undefined)
      .then((next) => !cancelled && setSummary(next))
    return () => {
      cancelled = true
    }
  }, [enabled, environmentId])
  return summary
}

export function HostKeysRows({ keys }: { keys: AgentApiKeySummary[] | null }): React.JSX.Element {
  const t = useTranslate()
  if (keys === null) {
    return <span className="sr-only">{t('agentHostPanel.keys.loading', 'Loading keys…')}</span>
  }
  if (keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('agentHostPanel.keys.noneHere', 'No keys apply to this host.')}{' '}
        {/* The footer's link style, so it reads as a link. */}
        <button
          type="button"
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-[var(--focus-ring)]"
          onClick={() => openAgentHostSettings('agentApiKeys')}
        >
          {t('agentHostPanel.keys.addOne', 'Add one in Agent API keys')}
        </button>
      </p>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {keys.map((key) => (
        <li key={key.id} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 py-2.5">
          <span className="text-sm text-foreground">{formatAgentTypeLabel(key.agent)}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-xs text-foreground">
              {key.envName} ••••{key.hint}
            </span>
            <span className="text-xs text-muted-foreground">
              {key.hostScope.kind === 'all'
                ? t('agentHostPanel.keys.scopeAll', 'Every host except Orca Cloud')
                : t('agentHostPanel.keys.scopeHosts', 'Only the hosts you picked')}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function useHostPanelBody(
  host: ResolvedAgentHost,
  capabilities: AgentHostCapabilities,
  generation: number,
  onCheckAgain: () => void
): { agents: React.ReactNode; keys: React.ReactNode; environment: React.ReactNode } {
  const runtimeReport = useHostAgentReport({
    kind: host.kind,
    availability: host.availability,
    environmentId: host.environmentId,
    generation
  })
  // Classic SSH has no Orca server: status and code sign-in run over SSH exec (Q8).
  const ssh = useSshClassicAgents(host, generation)
  const report = host.kind === 'sshClassic' ? ssh : runtimeReport
  const keys = useHostKeys(host.hostId)
  const wslAccounts = useAppStore((state) => {
    if (host.kind !== 'wsl' || !host.environmentId) {
      return null
    }
    const environment = state.runtimeEnvironments.find((entry) => entry.id === host.environmentId)
    const distro =
      environment && isWslHostRuntimeEnvironment(environment)
        ? environment.orcadDeployment.distro
        : null
    const accounts = wslSelectedAccounts(state.settings, distro)
    // A primitive snapshot so the selector stays stable between renders.
    return `${accounts.claude ?? ''}\u0000${accounts.codex ?? ''}`
  })
  const recipeSummary = useRecipeEnvSummary(host.kind === 'recipe', host.environmentId)
  const [signOutAgent, setSignOutAgent] = useState<HostAgentSignInAgent | null>(null)
  const unavailable = host.availability !== 'available'
  const agents = (
    <>
      <HostAgentsPanelSection
        title={capabilities.agents.title}
        help={capabilities.agents.help}
        host={host.label}
        rows={hostAgentPanelRows(report.report)}
        checking={report.checking}
        failed={report.failed}
        lastChecked={unavailable && report.report ? formatDate(report.report.checkedAt) : null}
        signOut={capabilities.signOut && (host.environmentId !== null || ssh.targetId !== null)}
        actionsDisabledReason={capabilities.actionsDisabledReason}
        onSignOut={setSignOutAgent}
        onCheckAgain={onCheckAgain}
        {...(wslAccounts !== null
          ? {
              accounts: {
                claude: wslAccounts.split('\u0000')[0] || null,
                codex: wslAccounts.split('\u0000')[1] || null
              }
            }
          : {})}
        {...(ssh.targetId
          ? {
              codeSignIn: {
                flows: ssh.flows,
                start: (agent: HostAgentSignInAgent) =>
                  void startSshAgentSignIn(ssh.targetId ?? '', agent),
                actions: {
                  submit: (flowId: string, code: string) =>
                    void submitSshAgentSignInCode(flowId, code),
                  cancel: cancelSshAgentSignIn,
                  retry: (flow) => void startSshAgentSignIn(flow.targetId, flow.agent),
                  openLink: (url: string) => void window.api.shell.openUrl(url),
                  copyAndOpen: (code: string, url: string) => {
                    void window.api.ui.writeClipboardText(code)
                    void window.api.shell.openUrl(url)
                  }
                }
              }
            }
          : {})}
      />
      {ssh.targetId ? (
        <SshSignOutDialog
          targetId={ssh.targetId}
          hostLabel={host.label}
          agent={signOutAgent}
          onClose={() => setSignOutAgent(null)}
        />
      ) : null}
      {host.environmentId ? (
        <HostAgentSignOutDialog
          environmentId={host.environmentId}
          hostLabel={host.label}
          agent={signOutAgent}
          onClose={() => setSignOutAgent(null)}
        />
      ) : null}
    </>
  )
  return {
    agents,
    keys: <HostKeysRows keys={keys} />,
    environment:
      host.kind === 'recipe' ? <RecipeEnvForwardingWarning summary={recipeSummary} /> : null
  }
}
