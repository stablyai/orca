import { useCallback, useMemo } from 'react'
import { Maximize2, Minimize2, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  isTuiAgentEnabled
} from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import { useTranslate } from '@/i18n/use-translate'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'

type FloatingTerminalWindowControlsProps = {
  maximized: boolean
  onToggleMaximized: () => void
  onMinimize: () => void
}

const controlButtonClassName =
  'border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground'

function withShortcutHint(label: string, shortcutLabel: string | null): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label
}

export function FloatingTerminalWindowControls({
  maximized,
  onToggleMaximized,
  onMinimize
}: FloatingTerminalWindowControlsProps): React.JSX.Element {
  const t = useTranslate()
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
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
    const result = launchAgentInNewTab({
      requestId: newAgentLaunchRequestId(),
      agent: defaultAgent,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'shortcut',
      // Do not change global activeTabId or dismiss the main editor; select within the floating group below.
      activate: false
    })
    if (!result || 'refused' in result) {
      return
    }
    if (result.surface.kind !== 'local-terminal') {
      return
    }
    // Update both selection models; the unified group drives the visible tab, while the other call updates the legacy map.
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, result.surface.tabId)
    activateTab(result.surface.tabId)
    focusTerminalTabSurface(result.surface.tabId)
  }, [activateTab, defaultAgent, setActiveTabForWorktree])

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
              aria-label={t(
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
            {t(
              'auto.components.floating.terminal.FloatingTerminalWindowControls.648352c51f',
              'Open {{value0}} in floating workspace',
              { value0: defaultAgentLabel ?? defaultAgent }
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
            aria-label={
              maximized
                ? t(
                    'auto.components.floating.terminal.FloatingTerminalWindowControls.1c79cba25d',
                    'Restore floating workspace'
                  )
                : t(
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
                t(
                  'auto.components.floating.terminal.FloatingTerminalWindowControls.b5686fee1e',
                  'Restore'
                ),
                maximizeShortcutLabel
              )
            : withShortcutHint(
                t(
                  'auto.components.floating.terminal.FloatingTerminalWindowControls.109870e023',
                  'Maximize'
                ),
                maximizeShortcutLabel
              )}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className={controlButtonClassName}
            aria-label={t(
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
            t(
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
