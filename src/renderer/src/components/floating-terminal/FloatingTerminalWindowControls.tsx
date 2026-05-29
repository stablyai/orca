import { useCallback, useMemo } from 'react'
import { Maximize2, Minimize2, Minus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon, buildAgentCatalog } from '@/lib/agent-catalog'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { isCustomTuiAgentId } from '../../../../shared/effective-tui-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'

type FloatingTerminalWindowControlsProps = {
  maximized: boolean
  onToggleMaximized: () => void
  onMinimize: () => void
}

const controlButtonClassName =
  'border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground'

export function FloatingTerminalWindowControls({
  maximized,
  onToggleMaximized,
  onMinimize
}: FloatingTerminalWindowControlsProps): React.JSX.Element {
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const customTuiAgents = useAppStore((s) => s.settings?.customTuiAgents ?? [])
  const createTab = useAppStore((s) => s.createTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const catalog = useMemo(() => buildAgentCatalog(customTuiAgents), [customTuiAgents])

  const disabledTuiAgents = useAppStore((s) => s.settings?.disabledTuiAgents ?? [])
  const defaultAgent =
    defaultTuiAgent && defaultTuiAgent !== 'blank'
      ? isCustomTuiAgentId(defaultTuiAgent)
        ? catalog.some((agent) => agent.id === defaultTuiAgent)
          ? defaultTuiAgent
          : null
        : isTuiAgentEnabled(defaultTuiAgent, disabledTuiAgents)
          ? defaultTuiAgent
          : null
      : null
  const defaultAgentLabel = useMemo(
    () =>
      defaultAgent
        ? (catalog.find((agent) => agent.id === defaultAgent)?.label ?? defaultAgent)
        : null,
    [catalog, defaultAgent]
  )

  const launchDefaultAgent = useCallback(() => {
    if (!defaultAgent) {
      return
    }
    const state = useAppStore.getState()
    const startupPlan = buildAgentStartupPlan({
      agent: defaultAgent,
      prompt: '',
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      customTuiAgents: state.settings?.customTuiAgents ?? [],
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      toast.error(`Could not build launch command for ${defaultAgentLabel ?? defaultAgent}.`)
      return
    }
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    state.queueTabStartupCommand(tab.id, {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(defaultAgent),
        launch_source: 'shortcut',
        request_kind: 'new'
      }
    })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
    const fresh = useAppStore.getState()
    const currentTabs = fresh.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const stored = fresh.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const validIds = new Set(currentTabs.map((entry) => entry.id))
    const order = stored.filter((id) => validIds.has(id) && id !== tab.id)
    for (const entry of currentTabs) {
      if (entry.id !== tab.id && !order.includes(entry.id)) {
        order.push(entry.id)
      }
    }
    order.push(tab.id)
    fresh.setTabBarOrder(FLOATING_TERMINAL_WORKTREE_ID, order)
    focusTerminalTabSurface(tab.id)
  }, [createTab, defaultAgent, defaultAgentLabel, setActiveTabForWorktree])

  return (
    <div className="flex items-center gap-1 px-2" data-floating-terminal-no-drag>
      {defaultAgent ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className={controlButtonClassName}
              aria-label={`Open ${defaultAgentLabel ?? defaultAgent} in floating workspace`}
              onClick={launchDefaultAgent}
            >
              <AgentIcon agent={defaultAgent} size={14} catalog={catalog} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Open {defaultAgentLabel ?? defaultAgent}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className={controlButtonClassName}
            aria-label={maximized ? 'Restore floating workspace' : 'Maximize floating workspace'}
            aria-pressed={maximized}
            onClick={onToggleMaximized}
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {maximized ? 'Restore' : 'Maximize'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className={controlButtonClassName}
            aria-label="Minimize floating workspace"
            onClick={onMinimize}
          >
            <Minus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          Minimize
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
