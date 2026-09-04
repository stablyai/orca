import React, { useCallback } from 'react'
import { Loader2, Settings as SettingsIcon, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchCustomAgentInNewTab } from '@/lib/launch-custom-agent-in-new-tab'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import { translate } from '@/i18n/i18n'
import { useStructuredCodexLaunchStatus } from '@/lib/structured-agent-session-launch'
import {
  isCustomAgentProfileEnabled,
  normalizeCustomAgentProfiles
} from '../../../../shared/custom-agent-profile'

export type QuickLaunchAgentMenuItemsProps = {
  worktreeId: string
  groupId: string
  /** Called after the tab is created so keyboard focus lands in the new xterm.
   *  Reuses the TabBar's existing double-rAF handoff — this component does
   *  not duplicate the focus logic. */
  onFocusTerminal: (tabId: string) => void
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

export function shouldShowLaunchWatchdogTimeout({ hasPty }: { hasPty: boolean }): boolean {
  return !hasPty
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

function watchTerminalLaunch(tabId: string, worktreeId: string, label: string): void {
  void waitForTerminalPty(tabId, 5000).then((hasPty) => {
    if (hasPty) {
      return
    }
    const launchState = getTerminalLaunchState(tabId)
    if (!launchState.stillOpen || useAppStore.getState().activeWorktreeId !== worktreeId) {
      return
    }
    if (shouldShowLaunchWatchdogTimeout({ hasPty: launchState.hasPty })) {
      toast.message(getLaunchWatchdogTimeoutMessage(label))
    }
  })
}

function QuickLaunchAgentMenuItemsInner({
  worktreeId,
  groupId,
  onFocusTerminal,
  prompt,
  promptDelivery,
  launchSource,
  onPromptDelivered
}: QuickLaunchAgentMenuItemsProps): React.JSX.Element | null {
  // Why: resolving only the SSH connectionId here made paired-runtime
  // worktrees fall back to LOCAL detection, listing the client's agents
  // instead of the remote server's. Use the same ssh/runtime/local owner
  // resolution as the rest of the tab bar.
  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(agentDetectionTarget)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const newAgentShortcut = useOptionalShortcutLabel('tab.newAgent')
  const structuredCodexLaunchStatus = useStructuredCodexLaunchStatus(worktreeId)
  const rawCustomProfiles = useAppStore((s) => s.settings?.customAgentProfiles)
  const customProfiles = normalizeCustomAgentProfiles(rawCustomProfiles)
  const enabledCustomProfiles = customProfiles.filter(isCustomAgentProfileEnabled)
  const defaultCustomAgent = enabledCustomProfiles.find((profile) => profile.isDefault) ?? null
  const launchableCustomProfiles =
    prompt !== undefined
      ? []
      : defaultCustomAgent
        ? [
            defaultCustomAgent,
            ...enabledCustomProfiles.filter((profile) => profile.id !== defaultCustomAgent.id)
          ]
        : enabledCustomProfiles

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
        groupId,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(promptDelivery !== undefined ? { promptDelivery } : {}),
        ...(launchSource !== undefined ? { launchSource } : {}),
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
      onFocusTerminal(result.tabId)
      watchTerminalLaunch(result.tabId, worktreeId, label)
    },
    [worktreeId, groupId, onFocusTerminal, prompt, promptDelivery, launchSource, onPromptDelivered]
  )

  const enabledDetectedIds = detectedIds ? filterEnabledTuiAgents(detectedIds, disabledAgents) : []
  const agents = detectedIds ? orderAgents(defaultAgent, enabledDetectedIds) : []
  const runCustomLaunch = (profileId: string, label: string): void => {
    const result = launchCustomAgentInNewTab({
      profileId,
      worktreeId,
      groupId
    })
    if (!result) {
      return
    }
    onFocusTerminal(result.tabId)
    watchTerminalLaunch(result.tabId, worktreeId, label)
  }

  return (
    <>
      {agents.length === 0 && launchableCustomProfiles.length === 0 ? (
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
        const entry = getCatalogEntry(agent)
        const label = entry?.label ?? agent
        const isStructuredCodexPending =
          agent === 'codex' && structuredCodexLaunchStatus === 'pending'
        const menuLabel = isStructuredCodexPending ? 'Starting Codex chat…' : label
        const showsDefaultAgentShortcut =
          newAgentShortcut !== null &&
          !defaultCustomAgent &&
          defaultAgent !== 'blank' &&
          agent === defaultAgent
        return (
          <DropdownMenuItem
            key={agent}
            disabled={isStructuredCodexPending}
            onSelect={() => runLaunch(agent)}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            title={translate(
              'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
              isStructuredCodexPending
                ? 'Starting Codex chat…'
                : 'Launch {{value0}} in a new terminal',
              isStructuredCodexPending ? undefined : { value0: label }
            )}
          >
            {isStructuredCodexPending ? (
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
      {agents.length > 0 && launchableCustomProfiles.length > 0 ? <DropdownMenuSeparator /> : null}
      {launchableCustomProfiles.map((profile) => (
        <DropdownMenuItem
          key={profile.id}
          onSelect={() => runCustomLaunch(profile.id, profile.name)}
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
          title={translate(
            'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
            'Launch {{value0}} in a new terminal',
            { value0: profile.name }
          )}
        >
          <Terminal className="size-3.5" />
          <span className="flex-1">{profile.name}</span>
          {newAgentShortcut !== null && profile.id === defaultCustomAgent?.id ? (
            <DropdownMenuShortcut>{newAgentShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
      ))}
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
