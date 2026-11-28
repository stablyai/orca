import React, { useCallback, useRef, useState } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import {
  getTerminalQuickCommandBody,
  isTerminalAgentQuickCommand
} from '../../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { useTabBarQuickCommandsShortcut } from './tab-bar-quick-commands-shortcut'
import type {
  HostedTerminalQuickCommand,
  TerminalQuickCommandHost
} from '@/lib/terminal/quick-commands/use-terminal-quick-command-hosts'

const LazyTabBarQuickCommandsMenuContent = lazyWithRetry(
  () =>
    import('./TabBarQuickCommandsMenuContent').then((module) => ({
      default: module.TabBarQuickCommandsMenuContent
    })),
  { reloadKey: 'tab-bar-quick-commands-menu-content' }
)

type TabBarQuickCommandsMenuProps = {
  isFocused: boolean
  repoCommands: readonly HostedTerminalQuickCommand[]
  globalCommands: readonly HostedTerminalQuickCommand[]
  mostRecent: HostedTerminalQuickCommand | null
  addHosts: readonly TerminalQuickCommandHost[]
  hostLoadFailed: boolean
  hostOwnershipPending: boolean
  onAddCommand: (hostId: TerminalQuickCommandHost['hostId']) => void
  onDeleteCommand: (entry: HostedTerminalQuickCommand) => void
  onEditCommand: (entry: HostedTerminalQuickCommand) => void
  onMenuOpen: () => void
  onRunCommand: (entry: HostedTerminalQuickCommand) => void
}

export function TabBarQuickCommandsMenu({
  isFocused,
  repoCommands,
  globalCommands,
  mostRecent,
  addHosts,
  hostLoadFailed,
  hostOwnershipPending,
  onAddCommand,
  onDeleteCommand,
  onEditCommand,
  onMenuOpen,
  onRunCommand
}: TabBarQuickCommandsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const openMenuShortcutCombos = useShortcutKeyComboDetails('tab.openQuickCommandsMenu')
  const [menuOpen, setMenuOpen] = useState(false)
  const hasOpenedMenu = useLatchedOpen(menuOpen)
  const [moreCommandsTooltipOpen, setMoreCommandsTooltipOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const focusBeforeOpenRef = useRef<HTMLElement | null>(null)
  const interactedOutsideRef = useRef(false)
  // Suppress tooltip reopening when closing the menu restores focus to its chevron.
  const suppressMoreCommandsTooltipRef = useRef(false)

  const handleMoreCommandsTooltipOpenChange = useCallback((next: boolean): void => {
    if (next && suppressMoreCommandsTooltipRef.current) {
      return
    }
    setMoreCommandsTooltipOpen(next)
  }, [])
  const allowMoreCommandsTooltip = useCallback((): void => {
    suppressMoreCommandsTooltipRef.current = false
  }, [])
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setMenuOpen(next)
      if (next) {
        focusBeforeOpenRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        interactedOutsideRef.current = false
        onMenuOpen()
        suppressMoreCommandsTooltipRef.current = false
        setMoreCommandsTooltipOpen(false)
        return
      }
      suppressMoreCommandsTooltipRef.current = true
      setMoreCommandsTooltipOpen(false)
    },
    [onMenuOpen]
  )
  const closeMenu = useCallback((): void => {
    handleOpenChange(false)
  }, [handleOpenChange])
  useTabBarQuickCommandsShortcut({ isFocused, menuOpen, onOpenChange: handleOpenChange })
  const runAndClose = useCallback(
    (entry: HostedTerminalQuickCommand): void => {
      closeMenu()
      onRunCommand(entry)
    },
    [closeMenu, onRunCommand]
  )

  const moreCommandsLabel = t(
    'auto.components.tab.bar.TabBarQuickCommandsButton.b82e237a4b',
    'More quick commands'
  )
  const splitButtonClass =
    'my-auto flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/60 text-muted-foreground'
  const innerButtonBase =
    'flex items-center bg-transparent leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
  return (
    <div className={splitButtonClass}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => mostRecent && runAndClose(mostRecent)}
            disabled={!mostRecent}
            className={cn(innerButtonBase, 'gap-1.5 rounded-l-md rounded-r-none px-1.5')}
            aria-label={
              mostRecent
                ? t(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.b775303755',
                    'Run quick command: {{value0}}',
                    { value0: mostRecent.command.label }
                  )
                : t(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                    'Run quick command'
                  )
            }
          >
            <Play className="size-3 shrink-0" fill="currentColor" strokeWidth={0} />
            {/* Why: keyed to the strip's width, not focus, so narrow split groups stay icon-only without reflowing. */}
            <span className="max-w-[160px] truncate text-[12px] font-medium @max-[480px]/tab-strip:hidden">
              {mostRecent?.command.label ??
                t('auto.components.tab.bar.TabBarQuickCommandsButton.7b1c9d6ae1', 'Run')}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {mostRecent
            ? isTerminalAgentQuickCommand(mostRecent.command)
              ? t(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.77ac113df0',
                  'Start {{value0}}: {{value1}}',
                  {
                    value0: getAgentLabel(mostRecent.command.agent),
                    value1: getTerminalQuickCommandBody(mostRecent.command)
                  }
                )
              : t(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.37e1bb90ce',
                  'Run: {{value0}}',
                  { value0: getTerminalQuickCommandBody(mostRecent.command) }
                )
            : t(
                'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                'Run quick command'
              )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
        <Tooltip open={moreCommandsTooltipOpen} onOpenChange={handleMoreCommandsTooltipOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                ref={triggerRef}
                type="button"
                className={cn(
                  innerButtonBase,
                  'justify-center rounded-l-none rounded-r-md border-l border-border/60 px-1'
                )}
                aria-label={moreCommandsLabel}
                onPointerEnter={allowMoreCommandsTooltip}
                onBlur={allowMoreCommandsTooltip}
              >
                <ChevronDown className="size-3" strokeWidth={2.5} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            <span className="inline-flex items-center gap-1.5">
              <span>{moreCommandsLabel}</span>
              {openMenuShortcutCombos.map((shortcut, index) => (
                <ShortcutKeyCombo
                  key={`${shortcut.keys.join('-')}-${index}`}
                  keys={shortcut.keys}
                  doubleTap={shortcut.doubleTap}
                  className="gap-0.5"
                  keyCapClassName="min-w-0 border-background/30 bg-background/10 px-1 py-0 text-[10px] text-background shadow-none"
                  separatorClassName="mx-0 text-[10px] text-background/70"
                />
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
        {hasOpenedMenu ? (
          <React.Suspense fallback={null}>
            <LazyTabBarQuickCommandsMenuContent
              isFocused={isFocused}
              menuOpen={menuOpen}
              repoCommands={repoCommands}
              globalCommands={globalCommands}
              mostRecent={mostRecent}
              addHosts={addHosts}
              hostLoadFailed={hostLoadFailed}
              hostOwnershipPending={hostOwnershipPending}
              triggerRef={triggerRef}
              focusBeforeOpenRef={focusBeforeOpenRef}
              interactedOutsideRef={interactedOutsideRef}
              onCloseMenu={closeMenu}
              onRunAndClose={runAndClose}
              onAddCommand={onAddCommand}
              onEditCommand={onEditCommand}
              onDeleteCommand={onDeleteCommand}
            />
          </React.Suspense>
        ) : null}
      </DropdownMenu>
    </div>
  )
}
