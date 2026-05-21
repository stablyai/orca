import React, { useCallback } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AGENT_CATALOG, AgentIcon, buildAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { waitForAgentReady } from '@/lib/agent-ready-wait'
import type { CustomTuiAgent, TuiAgentId } from '../../../../shared/types'
import type { LaunchSource } from '../../../../shared/telemetry-events'

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

function getCatalogEntry(
  agent: TuiAgentId,
  customAgents: readonly CustomTuiAgent[]
): { id: TuiAgentId; label: string } | null {
  const merged = buildAgentCatalog(customAgents)
  return merged.find((a) => a.id === agent) ?? null
}

function orderAgents(
  defaultAgent: TuiAgentId | 'blank' | null | undefined,
  detected: TuiAgentId[],
  customAgents: readonly CustomTuiAgent[]
): TuiAgentId[] {
  const builtInOrder = AGENT_CATALOG.filter((entry) => detected.includes(entry.id)).map(
    (entry) => entry.id
  )
  // Why: custom agent presets (issue #2284) land after built-ins in the picker,
  // sorted by their user-facing label for predictable ordering.
  const detectedCustoms = customAgents
    .filter((agent) => detected.includes(agent.id))
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((agent) => agent.id)
  const inCatalogOrder = [...builtInOrder, ...detectedCustoms]
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  // Why: surface the user's configured default first — matches the prior
  // split-button behavior where the default agent was the primary action.
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

export function shouldShowLaunchWatchdogTimeout({
  launchSource,
  prompt,
  pasteDraftAfterLaunch,
  hasPty
}: {
  launchSource?: LaunchSource
  prompt?: string
  pasteDraftAfterLaunch: boolean
  hasPty: boolean
}): boolean {
  return !(
    (launchSource === 'notes_send' || launchSource === 'conflict_resolution') &&
    (prompt?.trim().length ?? 0) > 0 &&
    pasteDraftAfterLaunch &&
    hasPty
  )
}

function getLaunchWatchdogTimeoutMessage(label: string): string {
  return `Couldn't launch ${label} — the terminal is still open.`
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
  const customTuiAgents = useAppStore((s) => s.settings?.customTuiAgents ?? [])
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const runLaunch = useCallback(
    (agent: TuiAgentId) => {
      const entry = getCatalogEntry(agent, customTuiAgents)
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
        toast.error(`Could not build launch command for ${label}.`)
        return
      }
      onFocusTerminal(result.tabId)

      // Why: the watchdog guards against "queued startup command never ran" —
      // e.g. shell failed to spawn. Suppress the toast if the tab has been
      // closed or the worktree has been navigated away from before the
      // deadline (see §States: Launch failure handling). Bracketed-paste
      // failures have their own toast in launch-agent-in-new-tab.ts.
      void waitForAgentReady(result.tabId, result.startupPlan.expectedProcess, {
        timeoutMs: 5000
      }).then((ready) => {
        if (ready.ready) {
          return
        }
        const state = useAppStore.getState()
        const stillOpen = Object.values(state.tabsByWorktree).some((tabs) =>
          tabs.some((t) => t.id === result.tabId)
        )
        if (!stillOpen) {
          return
        }
        if (state.activeWorktreeId !== worktreeId) {
          return
        }
        const hasPty = (state.ptyIdsByTabId[result.tabId]?.length ?? 0) > 0
        if (
          !shouldShowLaunchWatchdogTimeout({
            launchSource,
            prompt,
            pasteDraftAfterLaunch: result.pasteDraftAfterLaunch,
            hasPty
          })
        ) {
          return
        }
        toast.message(getLaunchWatchdogTimeoutMessage(label))
      })
    },
    [worktreeId, groupId, onFocusTerminal, prompt, promptDelivery, launchSource, onPromptDelivered]
  )

  const agents = detectedIds ? orderAgents(defaultAgent, detectedIds, customTuiAgents) : []

  return (
    <>
      {agents.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 text-muted-foreground"
        >
          No agents detected
        </DropdownMenuItem>
      ) : null}
      {agents.map((agent) => {
        const entry = getCatalogEntry(agent, customTuiAgents)
        const label = entry?.label ?? agent
        return (
          <DropdownMenuItem
            key={agent}
            onSelect={() => runLaunch(agent)}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            title={`Launch ${label} in a new terminal`}
          >
            <AgentIcon agent={agent} size={14} />
            {label}
          </DropdownMenuItem>
        )
      })}
      <DropdownMenuItem
        onSelect={openAgentSettings}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium text-muted-foreground"
      >
        <SettingsIcon className="size-4" />
        Agent settings…
      </DropdownMenuItem>
    </>
  )
}

export const QuickLaunchAgentMenuItems = React.memo(QuickLaunchAgentMenuItemsInner)
