import React, { useCallback } from 'react'
import { Settings as SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { waitForAgentReady } from '@/lib/agent-ready-wait'
import type { TuiAgent } from '../../../../shared/types'

export type QuickLaunchAgentMenuItemsProps = {
  worktreeId: string
  groupId: string
  /** Called after the tab is created so keyboard focus lands in the new xterm.
   *  Reuses the TabBar's existing double-rAF handoff — this component does
   *  not duplicate the focus logic. */
  onFocusTerminal: (tabId: string) => void
}

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string } | null {
  return AGENT_CATALOG.find((a) => a.id === agent) ?? null
}

function orderAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: TuiAgent[]
): TuiAgent[] {
  const inCatalogOrder = AGENT_CATALOG.filter((entry) => detected.includes(entry.id)).map(
    (entry) => entry.id
  )
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  // Why: surface the user's configured default first — matches the prior
  // split-button behavior where the default agent was the primary action.
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

function QuickLaunchAgentMenuItemsInner({
  worktreeId,
  groupId,
  onFocusTerminal
}: QuickLaunchAgentMenuItemsProps): React.JSX.Element | null {
  const { detectedIds } = useDetectedAgents()
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const openAgentSettings = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
  }, [openSettingsPage, openSettingsTarget])

  const runLaunch = useCallback(
    (agent: TuiAgent) => {
      const entry = getCatalogEntry(agent)
      const label = entry?.label ?? agent
      const result = launchAgentInNewTab({ agent, worktreeId, groupId })
      if (!result) {
        toast.error(`Could not build launch command for ${label}.`)
        return
      }
      onFocusTerminal(result.tabId)

      // Why: the watchdog guards against "queued startup command never ran" —
      // e.g. shell failed to spawn. Suppress the toast if the tab has been
      // closed or the worktree has been navigated away from before the
      // deadline (see §States: Launch failure handling).
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
        toast.message(`Couldn't launch ${label} — the terminal is still open.`)
      })
    },
    [worktreeId, groupId, onFocusTerminal]
  )

  const agents = detectedIds ? orderAgents(defaultAgent, detectedIds) : []

  return (
    <>
      <DropdownMenuSeparator />
      {agents.length === 0 ? (
        <DropdownMenuItem
          disabled
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 text-muted-foreground"
        >
          No agents detected
        </DropdownMenuItem>
      ) : null}
      {agents.map((agent) => {
        const entry = getCatalogEntry(agent)
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
