import { AlertCircle, AlertTriangle } from 'lucide-react'
import React from 'react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { useAppStore } from '@/store'
import { usePluginCommands, type ActivePluginCommand } from '@/store/plugin-panels'
import { usePluginStatusBarItems } from '@/store/plugin-status-bar-items'
import type { PluginStatusBarItemSnapshot } from '../../../../shared/plugins/plugin-status-bar'

function SeverityIcon({
  severity
}: {
  severity: PluginStatusBarItemSnapshot['severity']
}): React.JSX.Element | null {
  if (severity === 'warning') {
    return <AlertTriangle aria-hidden className="size-3 text-status-warning" />
  }
  if (severity === 'error') {
    return <AlertCircle aria-hidden className="size-3 text-destructive" />
  }
  return null
}

function PluginStatusBarItem({
  item,
  command,
  onOpenPanel
}: {
  item: PluginStatusBarItemSnapshot
  command: ActivePluginCommand | null
  onOpenPanel: (tabKey: `plugin:${string}`) => void
}): React.JSX.Element {
  const content = (
    <>
      <SeverityIcon severity={item.severity} />
      {/* Plugin text is rendered as plain text, never markup. */}
      <span className="max-w-64 truncate text-[11px]">{item.text}</span>
    </>
  )
  // Why the attribution: plugin text sits next to Orca's own segments, so the
  // label names its source and a plugin cannot pass itself off as Orca UI.
  const ariaLabel = translate(
    'auto.components.status.bar.PluginStatusBarItems.ariaLabel',
    '{{value0}}, from the {{value1}} plugin',
    { value0: item.tooltip ?? item.text, value1: item.pluginName }
  )
  const panelTabKey = item.panelTabKey
  const onClick = command
    ? (): void => {
        void executePluginCommand(command, 'plugin-status-bar').catch(() => {
          toast.error(
            translate('auto.App.pluginCommandFailed', 'Could not run the plugin command.')
          )
        })
      }
    : panelTabKey
      ? (): void => onOpenPanel(panelTabKey)
      : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            data-plugin-status-item={`${item.pluginKey}/${item.itemId}`}
            data-severity={item.severity}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
            aria-label={ariaLabel}
          >
            {content}
          </button>
        ) : (
          <span
            data-plugin-status-item={`${item.pluginKey}/${item.itemId}`}
            data-severity={item.severity}
            className="inline-flex items-center gap-1.5 px-1 py-0.5"
            aria-label={ariaLabel}
          >
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <div>{item.tooltip ?? item.text}</div>
        <div className="text-muted-foreground">
          {translate(
            'auto.components.status.bar.PluginStatusBarItems.attribution',
            'From the {{value0}} plugin',
            { value0: item.pluginName }
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/** Worker-published plugin items for one side of the status bar. */
export function PluginStatusBarItems({
  alignment
}: {
  alignment: PluginStatusBarItemSnapshot['alignment']
}): React.JSX.Element | null {
  const items = usePluginStatusBarItems(alignment)
  const commands = usePluginCommands()
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const setRightSidebarTab = useAppStore((state) => state.setRightSidebarTab)
  const setRightSidebarOpen = useAppStore((state) => state.setRightSidebarOpen)
  if (items.length === 0) {
    return null
  }
  const openPanel = (tabKey: `plugin:${string}`): void => {
    setRightSidebarTab(tabKey)
    setRightSidebarOpen(true)
  }
  return (
    <>
      {items.map((item) => {
        const command =
          commands.find(
            (entry) => entry.pluginKey === item.pluginKey && entry.id === item.command
          ) ?? null
        // Same availability rule as the command palette: worktree commands need one.
        const runnable =
          command && !(command.context === 'worktree' && !activeWorktreeId) ? command : null
        return (
          <PluginStatusBarItem
            key={`${item.pluginKey}/${item.itemId}`}
            item={item}
            command={runnable}
            onOpenPanel={openPanel}
          />
        )
      })}
    </>
  )
}

/** Left-aligned items lead the bar; the density hook measures this container
 *  as fixed width, so it renders only while there is something to show. */
export function PluginStatusBarLeadingItems({
  containerRef
}: {
  containerRef: (node: HTMLElement | null) => void
}): React.JSX.Element | null {
  const hasItems = usePluginStatusBarItems('left').length > 0
  if (!hasItems) {
    return null
  }
  return (
    <div ref={containerRef} className="flex shrink-0 items-center gap-3">
      <PluginStatusBarItems alignment="left" />
    </div>
  )
}
