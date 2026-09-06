import React, { useCallback } from 'react'
import { Loader2, Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { TopLevelView } from '../../../../shared/ui-chrome-types'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import { translate } from '@/i18n/i18n'
import { useStructuredAgentLaunchStatus } from '@/lib/structured-agent-session-launch'

export type QuickLaunchAgentMenuItemsProps = {
  worktreeId: string
  /** The host the user picked, from a surface that lists one row per host. A `worktreeId`
   *  names no host, so two publications of it are indistinguishable without this. */
  executionHostId?: ExecutionHostId
  /** Tab group the launch belongs to; surfaces without tab groups omit it. */
  groupId?: string
  /** Called with the new tab id once it exists. The tab bar focuses it, the
   *  session grid mounts it in the background — this component owns neither. */
  onLaunched: (tabId: string) => void
  /** Optional initial prompt forwarded to `launchAgentInNewTab`. When set,
   *  the picked agent boots with this prompt — argv/flag agents auto-submit,
   *  followup-path agents land it as a draft for the user to confirm. */
  prompt?: string
  /** Use non-default modes for generated context that must not become shell syntax. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface for `agent_started.launch_source`. Defaults to
   *  `'tab_bar_quick_launch'` so the existing tab-bar `+` callsite is
   *  unchanged. */
  launchSource?: LaunchSource
  /** Called after a prompt is queued into the agent, or immediately for argv prompt launches. */
  onPromptDelivered?: () => void
  /** Whether the launched tab takes the foreground. Default true, which is what the tab bar's
   *  `+` wants; a surface launching into a workspace it is not standing in passes false. */
  activate?: boolean
}

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string } | null {
  return getAgentCatalog().find((a) => a.id === agent) ?? null
}

function orderAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: TuiAgent[]
): TuiAgent[] {
  const inCatalogOrder = getAgentCatalog()
    .filter((entry) => detected.includes(entry.id))
    .map((entry) => entry.id)
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  // Why: surface the user's configured default first — matches the prior
  // split-button behavior where the default agent was the primary action.
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

/** The toast only fires on a surface where the user can see the failed launch. */
export function shouldShowLaunchWatchdogTimeout({
  hasPty,
  isWorktreeActive,
  activeView
}: {
  hasPty: boolean
  isWorktreeActive: boolean
  activeView: TopLevelView
}): boolean {
  if (hasPty) {
    return false
  }
  // Why the sessions view too: the grid launches into workspaces that are not
  // the active one, so its card would fail silently while the user watches it.
  return isWorktreeActive || activeView === 'sessions'
}

function getLaunchWatchdogTimeoutMessage(label: string): string {
  return `Couldn't launch ${label} — the terminal did not start.`
}

function getTerminalLaunchState(tabId: string): { stillOpen: boolean; hasPty: boolean } {
  const state = useAppStore.getState()
  const hasPtyBinding = (state.ptyIdsByTabId[tabId]?.length ?? 0) > 0
  let stillOpen = false
  let tabPtyId: string | null = null

  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      stillOpen = true
      tabPtyId = tab.ptyId
      break
    }
  }

  return { stillOpen, hasPty: hasPtyBinding || tabPtyId !== null }
}

async function waitForTerminalPty(tabId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const launchState = getTerminalLaunchState(tabId)
    if (launchState.hasPty) {
      return true
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return getTerminalLaunchState(tabId).hasPty
}

/** What a launch surface needs to list and start agents, with none of the menu markup. */
export type QuickLaunchAgentsController = {
  /** Enabled detected agents in catalog order, the user's default first. */
  agents: TuiAgent[]
  /** Null while detection has not answered; empty when the host reports none. */
  detectedIds: TuiAgent[] | null
  defaultAgent: TuiAgent | 'blank' | null | undefined
  /** The new-agent shortcut label, shown against the default agent only. */
  newAgentShortcut: string | null
  labelFor: (agent: TuiAgent) => string
  /** A structured native-chat launch for this agent is still starting; the row waits on it. */
  isLaunchPending: (agent: TuiAgent) => boolean
  runLaunch: (agent: TuiAgent) => void
  openAgentSettings: () => void
}

/**
 * The launch logic behind `QuickLaunchAgentMenuItems`, for a surface that renders its own
 * rows (the session grid's Command picker). Detection, ordering, the launch call and its
 * watchdog live here once, so the two surfaces cannot drift apart.
 */
export function useQuickLaunchAgents({
  worktreeId,
  executionHostId,
  groupId,
  onLaunched,
  prompt,
  promptDelivery,
  launchSource,
  onPromptDelivered,
  activate
}: QuickLaunchAgentMenuItemsProps): QuickLaunchAgentsController {
  // Why: resolving only the SSH connectionId here made paired-runtime
  // worktrees fall back to LOCAL detection, listing the client's agents
  // instead of the remote server's. Use the same ssh/runtime/local owner
  // resolution as the rest of the tab bar.
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId, executionHostId)
  const { detectedIds } = useDetectedAgents(agentDetectionTarget)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')
  // One hook per structured provider: the launch registry is keyed by agent, and hooks cannot run
  // inside the agent list's render loop.
  const structuredLaunchStatusByAgent = {
    claude: useStructuredAgentLaunchStatus(worktreeId, 'claude'),
    codex: useStructuredAgentLaunchStatus(worktreeId, 'codex')
  }

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const runLaunch = useCallback(
    (agent: TuiAgent) => {
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({
        agent,
        worktreeId,
        ...(executionHostId !== undefined ? { executionHostId } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
        ...(activate !== undefined ? { activate } : {}),
        ...(onPromptDelivered !== undefined ? { onPromptDelivered } : {})
      })
      if (!result) {
        toast.error(
          translate(
            'auto.components.tab.bar.QuickLaunchButton.465e432ef1',
            'Could not build launch command for {{value0}}.',
            { value0: label }
          )
        )
        return
      }
      if (!result.tabId) {
        // Why: paired web clients create the tab on the host; focus follows the
        // next session-tabs snapshot instead of a local tab id.
        return
      }
      onLaunched(result.tabId)

      // Why: launch success means the terminal session exists. Agent readiness
      // can lag behind on slow machines, and prompt paste flows already own
      // their own readiness timeout once a PTY exists.
      const launchedTabId = result.tabId
      void waitForTerminalPty(launchedTabId, 5000).then((hasPty) => {
        if (hasPty) {
          return
        }
        const launchState = getTerminalLaunchState(launchedTabId)
        if (!launchState.stillOpen) {
          return
        }
        const store = useAppStore.getState()
        if (
          !shouldShowLaunchWatchdogTimeout({
            hasPty: launchState.hasPty,
            isWorktreeActive: store.activeWorktreeId === worktreeId,
            activeView: store.activeView
          })
        ) {
          return
        }
        toast.message(getLaunchWatchdogTimeoutMessage(label))
      })
    },
    [
      worktreeId,
      executionHostId,
      groupId,
      onLaunched,
      prompt,
      promptDelivery,
      launchSource,
      activate,
      onPromptDelivered
    ]
  )

  const enabledDetectedIds = detectedIds ? filterEnabledTuiAgents(detectedIds, disabledAgents) : []
  const agents = detectedIds ? orderAgents(defaultAgent, enabledDetectedIds) : []
  const labelFor = useCallback((agent: TuiAgent) => getCatalogEntry(agent)?.label ?? agent, [])
  const isLaunchPending = (agent: TuiAgent): boolean =>
    isAgentSessionHandleProvider(agent) && structuredLaunchStatusByAgent[agent] === 'pending'

  return {
    agents,
    detectedIds,
    defaultAgent,
    newAgentShortcut,
    labelFor,
    isLaunchPending,
    runLaunch,
    openAgentSettings
  }
}

function QuickLaunchAgentMenuItemsInner(props: QuickLaunchAgentMenuItemsProps): React.JSX.Element {
  const {
    agents,
    detectedIds,
    defaultAgent,
    newAgentShortcut,
    labelFor,
    isLaunchPending,
    runLaunch,
    openAgentSettings
  } = useQuickLaunchAgents(props)

  return (
    <>
      {agents.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 text-muted-foreground"
        >
          {detectedIds && detectedIds.length > 0
            ? translate('auto.components.tab.bar.QuickLaunchButton.8dea9b5cdf', 'No enabled agents')
            : translate(
                'auto.components.tab.bar.QuickLaunchButton.e518f544b1',
                'No agents detected'
              )}
        </DropdownMenuItem>
      ) : null}
      {agents.map((agent) => {
        const label = labelFor(agent)
        const isStructuredLaunchPending = isLaunchPending(agent)
        const pendingLabel = translate(
          'components.native-chat.structuredSessionLaunchPending',
          'Starting {{value0}} chat…',
          { value0: label }
        )
        const menuLabel = isStructuredLaunchPending ? pendingLabel : label
        const showsDefaultAgentShortcut =
          newAgentShortcut !== null && defaultAgent !== 'blank' && agent === defaultAgent
        return (
          <DropdownMenuItem
            key={agent}
            disabled={isStructuredLaunchPending}
            onSelect={() => runLaunch(agent)}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            title={
              isStructuredLaunchPending
                ? pendingLabel
                : translate(
                    'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
                    'Launch {{value0}} in a new terminal',
                    { value0: label }
                  )
            }
          >
            {isStructuredLaunchPending ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <AgentIcon agent={agent} size={14} />
            )}
            <span className="flex-1">{menuLabel}</span>
            {showsDefaultAgentShortcut ? (
              <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )
      })}
      <DropdownMenuItem
        onSelect={openAgentSettings}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium text-muted-foreground"
      >
        <SettingsIcon className="size-4" />
        {translate('auto.components.tab.bar.QuickLaunchButton.348a04c1ad', 'Agent settings…')}
      </DropdownMenuItem>
    </>
  )
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
