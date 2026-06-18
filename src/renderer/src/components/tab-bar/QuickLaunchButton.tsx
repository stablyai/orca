import React, { useCallback } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { translate } from '@/i18n/i18n'
import { buildTabAgentLaunchGroups, orderTabLaunchAgents } from './tab-agent-launch-options'
import type { TabAgentLaunchGroup, TabAgentLaunchOption } from './tab-agent-launch-options'

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

function QuickLaunchAgentMenuItemsInner({
  worktreeId,
  groupId,
  onFocusTerminal,
  prompt,
  promptDelivery,
  launchSource,
  onPromptDelivered
}: QuickLaunchAgentMenuItemsProps): React.JSX.Element | null {
  // Why: must be a reactive selector (not getConnectionId() which reads a
  // snapshot via getState()). This ensures the component re-renders when the
  // SSH connection state changes. Returns undefined when the worktree isn't
  // found (store not hydrated), null for local repos, string for remote.
  const connectionId = useAppStore((s) => {
    const allWorktrees = Object.values(s.worktreesByRepo ?? {}).flat()
    const worktree = allWorktrees.find((w) => w.id === worktreeId)
    if (!worktree) {
      return undefined
    }
    const repo = s.repos?.find((r) => r.id === worktree.repoId)
    return repo?.connectionId ?? null
  })
  const { detectedIds } = useDetectedAgents(connectionId)
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore((s) => s.settings?.disabledTuiAgents ?? [])
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const runLaunch = useCallback(
    (option: TabAgentLaunchOption) => {
      const label = option.label
      const result = launchAgentInNewTab({
        agent: option.agent,
        ...(option.profileId ? { profileId: option.profileId } : {}),
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
        if (useAppStore.getState().activeWorktreeId !== worktreeId) {
          return
        }
        if (!shouldShowLaunchWatchdogTimeout({ hasPty: launchState.hasPty })) {
          return
        }
        toast.message(getLaunchWatchdogTimeoutMessage(label))
      })
    },
    [worktreeId, groupId, onFocusTerminal, prompt, promptDelivery, launchSource, onPromptDelivered]
  )

  const agentCmdOverrides = useAppStore((s) => s.settings?.agentCmdOverrides ?? {})
  const agentLaunchProfiles = useAppStore((s) => s.settings?.agentLaunchProfiles ?? [])
  const enabledDetectedIds = detectedIds ? filterEnabledTuiAgents(detectedIds, disabledAgents) : []
  const agents = detectedIds ? orderTabLaunchAgents(defaultAgent, enabledDetectedIds) : []
  const launchGroups = buildTabAgentLaunchGroups(agents, agentCmdOverrides, agentLaunchProfiles)

  return (
    <>
      {launchGroups.length === 0 ? (
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
      {launchGroups.map((group) => (
        <QuickLaunchAgentMenuGroup key={group.agent} group={group} onLaunch={runLaunch} />
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

function QuickLaunchAgentMenuGroup({
  group,
  onLaunch
}: {
  group: TabAgentLaunchGroup
  onLaunch: (option: TabAgentLaunchOption) => void
}): React.JSX.Element | null {
  if (group.options.length <= 1) {
    const option = group.options[0]
    if (!option) {
      return null
    }
    return <QuickLaunchAgentMenuItem option={option} onLaunch={onLaunch} />
  }
  const defaultOption = group.options[0]
  if (!defaultOption) {
    return null
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onLaunch(defaultOption)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          onLaunch(defaultOption)
        }}
        title={translate(
          'auto.components.tab.bar.QuickLaunchButton.e0e971d3db',
          'Launch {{value0}}. Hover for launch options.',
          { value0: group.label }
        )}
      >
        <AgentIcon agent={group.agent} size={14} />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span
          aria-label={translate(
            'auto.components.tab.bar.QuickLaunchButton.f4cc2c3aa4',
            '{{value0}} launch choices',
            { value0: group.options.length }
          )}
          className="flex h-4 min-w-5 shrink-0 items-center justify-center rounded-full border border-border/70 px-1.5 text-[10px] leading-none text-muted-foreground"
        >
          {group.options.length}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-40">
        {group.options.map((option) => (
          <QuickLaunchAgentMenuItem
            key={`${option.agent}:${option.profileId ?? 'default'}`}
            option={option}
            onLaunch={onLaunch}
          />
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function QuickLaunchAgentMenuItem({
  option,
  onLaunch
}: {
  option: TabAgentLaunchOption
  onLaunch: (option: TabAgentLaunchOption) => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem
      onSelect={() => onLaunch(option)}
      className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      title={translate(
        'auto.components.tab.bar.QuickLaunchButton.ec2adf093e',
        'Launch {{value0}} in a new terminal',
        { value0: option.label }
      )}
    >
      <AgentIcon agent={option.agent} size={14} />
      {option.menuLabel}
    </DropdownMenuItem>
  )
}
