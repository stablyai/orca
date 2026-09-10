import { RefreshCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { ClaudeIcon, OpenAIIcon } from './icons'
import { formatTimeAgo } from './tooltip'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import type { AgentHealthProvider, AgentHealthSnapshot } from '../../../../shared/agent-health'
import type {
  AgentProviderReadiness,
  AgentReadinessReason,
  AgentReadinessState
} from './agent-readiness'
import { getAgentHealthSnapshot, getProviderConnectionState } from './agent-health-presentation'
import { AgentHealthRows } from './AgentHealthRows'
import type { AgentUpdateUiState } from './use-agent-health'

export function agentReadinessStateLabel(state: AgentReadinessState): string {
  switch (state) {
    case 'ready':
      return translate('auto.components.status.bar.AgentStatusPanel.ready', 'Ready')
    case 'checking':
      return translate('auto.components.status.bar.AgentStatusPanel.checking', 'Checking')
    case 'action-required':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.actionRequired',
        'Action required'
      )
    case 'degraded':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.temporaryIssue',
        'Temporary issue'
      )
    case 'unavailable':
      return translate('auto.components.status.bar.AgentStatusPanel.unavailable', 'Unavailable')
    case 'unknown':
      return translate('auto.components.status.bar.AgentStatusPanel.unknown', 'Unknown')
  }
}

function agentReadinessReasonLabel(reason: AgentReadinessReason): string {
  switch (reason) {
    case 'ready':
      return translate('auto.components.status.bar.AgentStatusPanel.checkPassed', 'Check passed')
    case 'refreshing':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.refreshing',
        'Refreshing status'
      )
    case 'session-active':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.sessionActive',
        'Active session; usage check deferred'
      )
    case 'cli-checking':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.cliChecking',
        'Checking CLI availability'
      )
    case 'cli-unavailable':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.cliUnavailable',
        'CLI not found'
      )
    case 'sign-in-required':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.signInRequired',
        'Sign in again to use this account'
      )
    case 'sign-in-refreshing':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.signInRefreshing',
        'Refreshing sign-in; running sessions may still work'
      )
    case 'credential-unavailable':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.credentialUnavailable',
        'Credentials could not be read'
      )
    case 'network':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.network',
        'Network check failed'
      )
    case 'provider-error':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.providerError',
        'Provider check failed'
      )
    case 'limited':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.limited',
        'Provider is limiting checks'
      )
    case 'usage-unavailable':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.usageUnavailable',
        'Usage check unavailable'
      )
    case 'api-key-configured':
      return translate(
        'auto.components.status.bar.AgentStatusPanel.apiKeyConfigured',
        'API key configured; subscription usage is unavailable'
      )
    case 'not-checked':
      return translate('auto.components.status.bar.AgentStatusPanel.notChecked', 'Not checked')
  }
}

export function agentReadinessDotClass(state: AgentReadinessState): string {
  switch (state) {
    case 'ready':
      return 'bg-status-success'
    case 'checking':
    case 'degraded':
      return 'bg-status-warning'
    case 'action-required':
      return 'bg-destructive'
    case 'unavailable':
    case 'unknown':
      return 'bg-muted-foreground/40'
  }
}

export function agentReadinessToneClass(state: AgentReadinessState): string {
  switch (state) {
    case 'ready':
      return 'text-status-success'
    case 'checking':
    case 'degraded':
      return 'text-status-warning'
    case 'action-required':
      return 'text-destructive'
    case 'unavailable':
    case 'unknown':
      return 'text-muted-foreground'
  }
}

function ProviderIcon({ provider }: Pick<AgentProviderReadiness, 'provider'>): React.JSX.Element {
  return provider === 'claude' ? <ClaudeIcon size={13} /> : <OpenAIIcon size={13} />
}

function providerLabel(provider: AgentProviderReadiness['provider']): string {
  return provider === 'claude'
    ? translate('auto.components.status.bar.AgentStatusPanel.claudeCode', 'Claude Code')
    : translate('auto.components.status.bar.AgentStatusPanel.codex', 'Codex')
}

function checkedLabel(checkedAt: number | null): string | null {
  if (!checkedAt) {
    return null
  }
  return translate('auto.components.status.bar.AgentStatusPanel.checked', 'Checked {{value0}}', {
    value0: formatTimeAgo(checkedAt)
  })
}

function ProviderReadinessRows({
  provider,
  mode,
  healthSnapshots,
  healthPendingProviders,
  updateStates,
  onCheckAgent,
  onUpdateAgent
}: {
  provider: AgentProviderReadiness
  mode: StatusBarUsageMode
  healthSnapshots: readonly AgentHealthSnapshot[]
  healthPendingProviders: Partial<Record<AgentHealthProvider, boolean>>
  updateStates: Partial<Record<AgentHealthProvider, AgentUpdateUiState>>
  onCheckAgent: (provider: AgentHealthProvider) => void
  onUpdateAgent: (provider: AgentHealthProvider) => void
}): React.JSX.Element {
  const healthSnapshot = getAgentHealthSnapshot(healthSnapshots, provider.provider)
  const healthPending = healthPendingProviders[provider.provider] === true
  const connectionState = getProviderConnectionState(provider, healthSnapshot, healthPending)
  const accounts =
    mode === 'compact'
      ? provider.activeAccount
        ? [provider.activeAccount]
        : []
      : provider.accounts
  return (
    <div className="border-b border-border/70 last:border-b-0">
      <div className="flex items-center gap-2.5 px-3.5 pb-1.5 pt-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
          <ProviderIcon provider={provider.provider} />
        </span>
        <span className="text-[13px] font-medium text-foreground">
          {providerLabel(provider.provider)}
        </span>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 text-[11px] ${agentReadinessToneClass(connectionState)}`}
        >
          <span className={`size-1.5 rounded-full ${agentReadinessDotClass(connectionState)}`} />
          {agentReadinessStateLabel(connectionState)}
        </span>
      </div>
      <AgentHealthRows
        snapshot={healthSnapshot}
        connectionState={connectionState}
        pending={healthPending}
        mode={mode}
        updateState={updateStates[provider.provider]}
        onCheck={onCheckAgent}
        onUpdate={onUpdateAgent}
      />
      <div className="pb-2">
        {accounts.map((account) => {
          const checked = checkedLabel(account.checkedAt)
          return (
            <div key={account.id ?? 'system'} className="flex items-start gap-2.5 px-3.5 py-1.5">
              <span
                className={`mt-1 size-1.5 shrink-0 rounded-full ${agentReadinessDotClass(account.state)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] text-foreground">{account.label}</span>
                  {account.active ? (
                    <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
                      {translate('auto.components.status.bar.AgentStatusPanel.active', 'Active')}
                    </span>
                  ) : null}
                </div>
                {mode === 'verbose' ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                    <span>{agentReadinessReasonLabel(account.reason)}</span>
                    {checked ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{checked}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <span className={`shrink-0 text-[10px] ${agentReadinessToneClass(account.state)}`}>
                {agentReadinessStateLabel(account.state)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function AgentStatusPanel({
  providers,
  healthSnapshots,
  healthPendingProviders,
  updateStates,
  mode,
  ownerLabel,
  isRefreshing,
  loadError,
  onModeChange,
  onRefresh,
  onCheckAgent,
  onUpdateAgent,
  onManageAccounts
}: {
  providers: AgentProviderReadiness[]
  healthSnapshots: readonly AgentHealthSnapshot[]
  healthPendingProviders: Partial<Record<AgentHealthProvider, boolean>>
  updateStates: Partial<Record<AgentHealthProvider, AgentUpdateUiState>>
  mode: StatusBarUsageMode
  ownerLabel: string
  isRefreshing: boolean
  loadError: boolean
  onModeChange: (mode: StatusBarUsageMode) => void
  onRefresh: () => void
  onCheckAgent: (provider: AgentHealthProvider) => void
  onUpdateAgent: (provider: AgentHealthProvider) => void
  onManageAccounts: () => void
}): React.JSX.Element {
  return (
    <div className="w-[360px] text-xs">
      <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">
            {translate('auto.components.status.bar.AgentStatusPanel.title', 'Agent status')}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{ownerLabel}</div>
        </div>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onRefresh()
          }}
          aria-label={translate(
            'auto.components.status.bar.AgentStatusPanel.refresh',
            'Refresh agent status'
          )}
          className="size-5 justify-center p-0"
        >
          <RefreshCw className={`size-3 ${isRefreshing ? 'animate-spin' : ''}`} />
        </DropdownMenuItem>
      </div>
      <div className="px-3.5 pb-2.5">
        <SettingsSegmentedControl<StatusBarUsageMode>
          value={mode}
          onChange={onModeChange}
          ariaLabel={translate(
            'auto.components.status.bar.AgentStatusPanel.detailLevel',
            'Agent status detail'
          )}
          size="sm"
          equalWidth
          options={[
            {
              value: 'verbose',
              label: translate('auto.components.status.bar.AgentStatusPanel.detailed', 'Detailed')
            },
            {
              value: 'compact',
              label: translate('auto.components.status.bar.AgentStatusPanel.compact', 'Compact')
            }
          ]}
        />
      </div>
      <div className="border-t border-border/70 px-3.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {translate(
          'auto.components.status.bar.AgentStatusPanel.connectionStatus',
          'Connection status'
        )}
      </div>
      {loadError ? (
        <div className="border-t border-border/70 px-3.5 py-2 text-[11px] text-destructive">
          {translate(
            'auto.components.status.bar.AgentStatusPanel.loadError',
            'Some agent status could not be loaded.'
          )}
        </div>
      ) : null}
      <div className="max-h-[320px] overflow-y-auto border-t border-border/70 scrollbar-sleek">
        {providers.map((provider) => (
          <ProviderReadinessRows
            key={provider.provider}
            provider={provider}
            mode={mode}
            healthSnapshots={healthSnapshots}
            healthPendingProviders={healthPendingProviders}
            updateStates={updateStates}
            onCheckAgent={onCheckAgent}
            onUpdateAgent={onUpdateAgent}
          />
        ))}
      </div>
      <DropdownMenuItem
        onSelect={onManageAccounts}
        className="w-full cursor-pointer rounded-none border-t border-border/70 px-3.5 py-2.5 text-[13px] text-foreground"
      >
        {translate('auto.components.status.bar.StatusBar.75ded02687', 'Manage Accounts…')}
      </DropdownMenuItem>
    </div>
  )
}
