import { useCallback, useMemo } from 'react'
import { ExternalLink, Maximize2, Minimize2, Minus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FloatingTerminalDisplaysMenu } from './FloatingTerminalDisplaysMenu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspaceDisplayInfo } from '../../../../shared/floating-workspace-display'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  isTuiAgentEnabled
} from '../../../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { translate } from '@/i18n/i18n'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'

export type FloatingTerminalWindowControlsProps = {
  maximized: boolean
  onToggleMaximized: () => void
  onMinimize: () => void
  isDetached?: boolean
  onToggleDetached?: () => void
  displays?: readonly WorkspaceDisplayInfo[]
  currentDisplayId?: number | null
  onMoveToNextDisplay?: () => void
  onMoveToDisplay?: (displayId: number) => void
  onIdentifyDisplays?: () => void
  onRefreshDisplays?: () => void
}

const controlButtonClassName =
  'border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground'

// Why: matches the repo convention (e.g. ReviewPRViewAnimatedVisual) of
// surfacing the live keybinding in a tooltip as "Label (shortcut)", while
// degrading to a bare label when the action is unbound (default on Win/Linux,
// and for minimize on every platform).
function withShortcutHint(label: string, shortcutLabel: string | null): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label
}

const EMPTY_DISPLAYS: readonly WorkspaceDisplayInfo[] = []

export function FloatingTerminalWindowControls({
  maximized,
  onToggleMaximized,
  onMinimize,
  isDetached = false,
  onToggleDetached,
  displays = EMPTY_DISPLAYS,
  currentDisplayId,
  onMoveToNextDisplay,
  onMoveToDisplay,
  onIdentifyDisplays,
  onRefreshDisplays
}: FloatingTerminalWindowControlsProps): React.JSX.Element {
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const createTab = useAppStore((s) => s.createTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const activateTab = useAppStore((s) => s.activateTab)
  const maximizeShortcutLabel = useOptionalShortcutLabel('floatingWorkspace.maximize')
  const minimizeShortcutLabel = useOptionalShortcutLabel('floatingWorkspace.minimize')

  const disabledTuiAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const defaultAgent =
    defaultTuiAgent &&
    defaultTuiAgent !== 'blank' &&
    isTuiAgentEnabled(defaultTuiAgent, disabledTuiAgents)
      ? defaultTuiAgent
      : null
  const defaultAgentLabel = useMemo(
    () =>
      defaultAgent
        ? (getAgentCatalog().find((agent) => agent.id === defaultAgent)?.label ?? defaultAgent)
        : null,
    [defaultAgent]
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
      agentArgs: resolveTuiAgentLaunchArgs(defaultAgent, state.settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(defaultAgent, state.settings?.agentDefaultEnv),
      platform: CLIENT_PLATFORM,
      allowEmptyPromptLaunch: true
    })
    if (!startupPlan) {
      toast.error(
        translate(
          'auto.components.floating.terminal.FloatingTerminalWindowControls.82da3701e7',
          'Could not build launch command for {{value0}}.',
          { value0: defaultAgentLabel ?? defaultAgent }
        )
      )
      return
    }
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    state.queueTabStartupCommand(tab.id, {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      launchAgent: defaultAgent,
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(defaultAgent),
        launch_source: 'shortcut',
        request_kind: 'new'
      }
    })
    // Why: the floating panel renders its visible tab from the unified group's
    // activeTabId. setActiveTabForWorktree only writes activeTabIdByWorktree, so
    // the new agent tab would be appended but never selected/focused. activateTab
    // selects it within the group, matching the empty-state tab creators.
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
    activateTab(tab.id)
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
  }, [activateTab, createTab, defaultAgent, defaultAgentLabel, setActiveTabForWorktree])

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
              aria-label={translate(
                'auto.components.floating.terminal.FloatingTerminalWindowControls.648352c51f',
                'Open {{value0}} in floating workspace',
                { value0: defaultAgentLabel ?? defaultAgent }
              )}
              onClick={launchDefaultAgent}
            >
              <AgentIcon agent={defaultAgent} size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.floating.terminal.FloatingTerminalWindowControls.648352c51f',
              'Open {{value0}} in floating workspace',
              { value0: defaultAgentLabel ?? defaultAgent }
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <FloatingTerminalDisplaysMenu
        displays={displays}
        currentDisplayId={currentDisplayId}
        isDetached={isDetached}
        controlButtonClassName={controlButtonClassName}
        onMoveToDisplay={onMoveToDisplay}
        onMoveToNextDisplay={onMoveToNextDisplay}
        onIdentifyDisplays={onIdentifyDisplays}
        onRefreshDisplays={onRefreshDisplays}
        onToggleDetached={onToggleDetached}
      />
      {onToggleDetached ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className={controlButtonClassName}
              aria-label={
                isDetached
                  ? translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.dock',
                      'Dock floating workspace into main window'
                    )
                  : translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.detach',
                      'Detach floating workspace to separate window'
                    )
              }
              onClick={onToggleDetached}
            >
              {isDetached ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <ExternalLink className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {isDetached
              ? translate(
                  'auto.components.floating.terminal.FloatingTerminalWindowControls.dock',
                  'Dock into main window'
                )
              : translate(
                  'auto.components.floating.terminal.FloatingTerminalWindowControls.detach',
                  'Detach to separate window'
                )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {!isDetached ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className={controlButtonClassName}
              aria-label={
                maximized
                  ? translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.1c79cba25d',
                      'Restore floating workspace'
                    )
                  : translate(
                      'auto.components.floating.terminal.FloatingTerminalWindowControls.3f4ca29961',
                      'Maximize floating workspace'
                    )
              }
              aria-pressed={maximized}
              onClick={onToggleMaximized}
            >
              {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {maximized
              ? withShortcutHint(
                  translate(
                    'auto.components.floating.terminal.FloatingTerminalWindowControls.b5686fee1e',
                    'Restore'
                  ),
                  maximizeShortcutLabel
                )
              : withShortcutHint(
                  translate(
                    'auto.components.floating.terminal.FloatingTerminalWindowControls.109870e023',
                    'Maximize'
                  ),
                  maximizeShortcutLabel
                )}
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
            aria-label={translate(
              'auto.components.floating.terminal.FloatingTerminalWindowControls.1bbaa0302f',
              'Minimize floating workspace'
            )}
            onClick={onMinimize}
          >
            <Minus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {withShortcutHint(
            translate(
              'auto.components.floating.terminal.FloatingTerminalWindowControls.2f6054342c',
              'Minimize'
            ),
            minimizeShortcutLabel
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
