import { Bot, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import {
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import {
  buildAgentReadiness,
  shouldShowAgentReadiness,
  type AgentReadinessState
} from './agent-readiness'
import { getOverallAgentConnectionState } from './agent-health-presentation'
import { useAgentHealth } from './use-agent-health'
import {
  getClaudeStatusAccountsFromSettings,
  getCodexStatusAccountsFromSettings
} from './status-bar-provider-accounts'
import {
  AgentStatusPanel,
  agentReadinessDotClass,
  agentReadinessToneClass
} from './AgentStatusPanel'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

const EMPTY_CLAUDE_ACCOUNTS: ClaudeRateLimitAccountsState = {
  accounts: [],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} }
}

const EMPTY_CODEX_ACCOUNTS: CodexRateLimitAccountsState = {
  accounts: [],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} }
}

const AGENT_STATUS_CLI_POLL_MS = 15 * 60_000

function summaryLabel(state: AgentReadinessState, count: number): string {
  switch (state) {
    case 'ready':
      return count === 1
        ? translate('auto.components.status.bar.AgentStatusSegment.oneReady', 'Agent ready')
        : translate('auto.components.status.bar.AgentStatusSegment.ready', 'Agents ready')
    case 'checking':
      return translate('auto.components.status.bar.AgentStatusSegment.checking', 'Checking agents')
    case 'action-required':
      return translate(
        'auto.components.status.bar.AgentStatusSegment.actionRequired',
        'Agent action required'
      )
    case 'degraded':
      return translate('auto.components.status.bar.AgentStatusSegment.issue', 'Agent check issue')
    case 'unavailable':
      return translate(
        'auto.components.status.bar.AgentStatusSegment.unavailable',
        'Agent unavailable'
      )
    case 'unknown':
      return translate(
        'auto.components.status.bar.AgentStatusSegment.unknown',
        'Agent status unknown'
      )
  }
}

function localAccountSyncKey(
  claude: ClaudeRateLimitAccountsState,
  codex: CodexRateLimitAccountsState
): string {
  const accountKey = (account: { id: string; updatedAt: number }): string =>
    `${account.id}:${account.updatedAt}`
  return [
    claude.activeAccountId,
    JSON.stringify(claude.activeAccountIdsByRuntime ?? null),
    claude.accounts.map(accountKey).join('|'),
    codex.activeAccountId,
    JSON.stringify(codex.activeAccountIdsByRuntime ?? null),
    codex.accounts.map(accountKey).join('|')
  ].join(':')
}

export function AgentStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const localRateLimits = useAppStore((state) => state.rateLimits)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const refreshRateLimits = useAppStore((state) => state.refreshRateLimits)
  const fetchInactiveClaudeAccountUsage = useAppStore(
    (state) => state.fetchInactiveClaudeAccountUsage
  )
  const fetchInactiveCodexAccountUsage = useAppStore(
    (state) => state.fetchInactiveCodexAccountUsage
  )
  const statusBarUsageMode = useAppStore((state) => state.statusBarUsageMode)
  const setStatusBarUsageMode = useAppStore((state) => state.setStatusBarUsageMode)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const detectionTargetReady = Boolean(settings)
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() || null
  const localClaudeAccounts = useMemo(
    () => getClaudeStatusAccountsFromSettings(settings) ?? EMPTY_CLAUDE_ACCOUNTS,
    [settings]
  )
  const localCodexAccounts = useMemo(
    () => getCodexStatusAccountsFromSettings(settings) ?? EMPTY_CODEX_ACCOUNTS,
    [settings]
  )
  const localAccountFallbacksRef = useRef({
    claude: localClaudeAccounts,
    codex: localCodexAccounts
  })
  const accountOwnerKey = activeRuntimeEnvironmentId
    ? `runtime:${activeRuntimeEnvironmentId}`
    : `local:${localAccountSyncKey(localClaudeAccounts, localCodexAccounts)}`
  const detectionTarget = useMemo<AgentDetectionTarget | undefined>(() => {
    if (!settings) {
      return undefined
    }
    return activeRuntimeEnvironmentId
      ? { kind: 'runtime', environmentId: activeRuntimeEnvironmentId }
      : { kind: 'local' }
  }, [activeRuntimeEnvironmentId, settings])
  const detectedAgents = useDetectedAgents(detectionTarget)
  const refreshDetectedAgents = detectedAgents.refresh
  const {
    snapshots: healthSnapshots,
    isProbing: healthPending,
    pendingProviders: healthPendingProviders,
    loadError: healthLoadError,
    updateStates,
    refresh: refreshAgentHealth,
    check: checkAgentHealth,
    update: updateAgent
  } = useAgentHealth(activeRuntimeEnvironmentId, detectionTargetReady)
  const [snapshot, setSnapshot] = useState<ProviderAccountsSnapshot | null>(null)
  const [accountLoadError, setAccountLoadError] = useState(false)
  const [detectionLoadError, setDetectionLoadError] = useState(false)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [manualRefreshPending, setManualRefreshPending] = useState(false)

  useEffect(() => {
    localAccountFallbacksRef.current = {
      claude: localClaudeAccounts,
      codex: localCodexAccounts
    }
  }, [localClaudeAccounts, localCodexAccounts])

  useEffect(() => {
    setSnapshot(null)
    setAccountLoadError(false)
    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId },
      {
        onSnapshot: (next) => {
          setSnapshot((previous) => ({
            ...next,
            claude: next.failedProviders?.includes('claude')
              ? (previous?.claude ?? localAccountFallbacksRef.current.claude)
              : next.claude,
            codex: next.failedProviders?.includes('codex')
              ? (previous?.codex ?? localAccountFallbacksRef.current.codex)
              : next.codex
          }))
          setAccountLoadError(Boolean(next.failedProviders?.length))
        },
        onError: () => setAccountLoadError(true)
      }
    )
    return watcher.close
  }, [accountOwnerKey, activeRuntimeEnvironmentId, refreshGeneration])

  useEffect(() => {
    if (!detectionTargetReady) {
      return
    }
    const interval = window.setInterval(() => {
      void refreshDetectedAgents().then(
        () => setDetectionLoadError(false),
        () => setDetectionLoadError(true)
      )
    }, AGENT_STATUS_CLI_POLL_MS)
    return () => window.clearInterval(interval)
  }, [detectionTargetReady, refreshDetectedAgents])

  const claudeAccounts = activeRuntimeEnvironmentId
    ? (snapshot?.claude ?? EMPTY_CLAUDE_ACCOUNTS)
    : localClaudeAccounts
  const codexAccounts = activeRuntimeEnvironmentId
    ? (snapshot?.codex ?? EMPTY_CODEX_ACCOUNTS)
    : {
        ...localCodexAccounts,
        systemDefault: snapshot?.codex.systemDefault ?? localCodexAccounts.systemDefault
      }
  const rateLimits = activeRuntimeEnvironmentId ? (snapshot?.rateLimits ?? null) : localRateLimits
  const providers = buildAgentReadiness({
    claudeAccounts,
    codexAccounts,
    rateLimits,
    detectedAgentIds: detectedAgents.detectedIds,
    detectionPending: detectedAgents.isLoading || detectedAgents.isRefreshing,
    systemDefaultLabel: translate(
      'auto.components.status.bar.StatusBar.c676918adc',
      'System default'
    )
  }).filter(shouldShowAgentReadiness)
  const measuredOverall = getOverallAgentConnectionState(
    providers,
    healthSnapshots,
    healthPendingProviders
  )
  const loadError =
    accountLoadError || detectionLoadError || detectedAgents.detectionFailed || healthLoadError
  const overall =
    loadError && ['ready', 'unknown', 'checking'].includes(measuredOverall)
      ? 'degraded'
      : measuredOverall
  const anyProviderFetching = providers.some((provider) => provider.reason === 'refreshing')
  const isRefreshing =
    manualRefreshPending ||
    detectedAgents.isRefreshing ||
    detectedAgents.isLoading ||
    healthPending ||
    anyProviderFetching
  const ownerLabel = activeRuntimeEnvironmentId
    ? (runtimeEnvironments.find((environment) => environment.id === activeRuntimeEnvironmentId)
        ?.name ??
      translate('auto.components.status.bar.AgentStatusSegment.remoteServer', 'Remote server'))
    : translate('auto.components.status.bar.AgentStatusSegment.thisDevice', 'This device')

  const refresh = useCallback(async (): Promise<void> => {
    if (manualRefreshPending) {
      return
    }
    setManualRefreshPending(true)
    try {
      const requests = [
        refreshDetectedAgents(),
        refreshAgentHealth(),
        ...(activeRuntimeEnvironmentId
          ? []
          : [
              refreshRateLimits(),
              fetchInactiveClaudeAccountUsage(),
              fetchInactiveCodexAccountUsage()
            ])
      ]
      const results = await Promise.allSettled(requests)
      setDetectionLoadError(results[0]?.status === 'rejected')
      setRefreshGeneration((generation) => generation + 1)
    } finally {
      setManualRefreshPending(false)
    }
  }, [
    activeRuntimeEnvironmentId,
    fetchInactiveClaudeAccountUsage,
    fetchInactiveCodexAccountUsage,
    manualRefreshPending,
    refreshAgentHealth,
    refreshDetectedAgents,
    refreshRateLimits
  ])

  if (providers.length === 0) {
    return null
  }
  const label = summaryLabel(overall, providers.length)

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !activeRuntimeEnvironmentId) {
          void Promise.all([fetchInactiveClaudeAccountUsage(), fetchInactiveCodexAccountUsage()])
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={label}
        >
          {isRefreshing ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <Bot className={`size-3 ${agentReadinessToneClass(overall)}`} />
          )}
          {!compact && !iconOnly ? (
            <span className="text-[11px] text-muted-foreground">{label}</span>
          ) : null}
          <span className={`size-1.5 rounded-full ${agentReadinessDotClass(overall)}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={{ top: 8, bottom: 32, left: 8, right: 8 }}
        className="w-[360px] p-0"
      >
        <AgentStatusPanel
          providers={providers}
          healthSnapshots={healthSnapshots}
          healthPendingProviders={healthPendingProviders}
          updateStates={updateStates}
          mode={statusBarUsageMode}
          ownerLabel={ownerLabel}
          isRefreshing={isRefreshing}
          loadError={loadError}
          onModeChange={setStatusBarUsageMode}
          onRefresh={() => void refresh()}
          onCheckAgent={(provider) => void checkAgentHealth(provider).catch(() => {})}
          onUpdateAgent={(provider) => void updateAgent(provider)}
          onManageAccounts={() => {
            openSettingsTarget({ pane: 'accounts', repoId: null })
            openSettingsPage()
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
