import { useCallback, useMemo } from 'react'
import { Maximize2, Minimize2, Minus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  isTuiAgentEnabled
} from '../../../../shared/tui-agent-selection'
import { translate } from '@/i18n/i18n'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'

type FloatingTerminalWindowControlsProps = {
  maximized: boolean
  onToggleMaximized: () => void
  onMinimize: () => void
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

export function FloatingTerminalWindowControls({
  maximized,
  onToggleMaximized,
  onMinimize
}: FloatingTerminalWindowControlsProps): React.JSX.Element {
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
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
    // Why: the shared launcher owns the startup plan, the route and the tab identity, so this
    // button stays one more caller of it rather than a second copy of new-agent-tab startup.
    // Floating resolves the terminal-backed lane: a chat view over a PTY when the chat default is
    // on, never a structured session.
    const result = launchAgentInNewTab({
      agent: defaultAgent,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'shortcut'
    })
    if (!result) {
      toast.error(
        translate(
          'auto.components.floating.terminal.FloatingTerminalWindowControls.82da3701e7',
          'Could not build launch command for {{value0}}.',
          { value0: defaultAgentLabel ?? defaultAgent }
        )
      )
      return
    }
    if (result.surface.kind !== 'local-terminal') {
      return
    }
    focusTerminalTabSurface(result.surface.tabId)
  }, [defaultAgent, defaultAgentLabel])

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
