import { Bot, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../store'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { getDetectionTargetIdentityForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useNewTabAgentMenuRows } from '../tab-bar/use-new-tab-agent-menu-rows'
import { QuickLaunchAgentMenuItems, useTabAgentMenuLaunch } from '../tab-bar/QuickLaunchButton'
import { rowId, rowLabel } from '../tab-bar/tab-agent-row-presentation'
import {
  readNewAgentTabDefault,
  resolveTerminalAgentTabShortcut
} from '../terminal-agent-tab-shortcut'
import { launchAgentTabShortcut } from '../agent-tab-shortcut-launch'
import {
  LandingItemShortcut,
  landingQueryMatches,
  useLandingResultsChange
} from './split-pane-landing-item'

/** The default agent, launched exactly as the New Agent shortcut would launch it; the chevron
 *  opens the + menu's agent list for any other. */
export function LandingDefaultAgentItem({
  worktreeId,
  groupId,
  pickerOpen,
  onPickerOpenChange,
  onPickerClosed
}: {
  worktreeId: string
  groupId: string
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  /** Hands focus back to the search field instead of Radix's trigger restore. */
  onPickerClosed: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const defaultAgent = useAppStore((state) => readNewAgentTabDefault(state, worktreeId))
  const shortcut = useOptionalShortcutLabel('tab.newAgent')
  const agentLabel = defaultAgent
    ? (getAgentCatalog().find((entry) => entry.id === defaultAgent)?.label ?? defaultAgent)
    : null
  const label = agentLabel
    ? t('components.tabGroup.splitPaneLanding.newNamedAgent', 'New {{agent}} agent', {
        agent: agentLabel
      })
    : t('components.tabGroup.splitPaneLanding.newAgent', 'New Agent')

  const launchDefault = (): void => {
    const resolved = resolveTerminalAgentTabShortcut({
      activeWorktreeId: worktreeId,
      keybindings: useAppStore.getState().keybindings,
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })
    const detectionTarget = getDetectionTargetIdentityForWorktree(
      useAppStore.getState(),
      worktreeId
    )
    // Why: same cancellation as the keyboard shortcut, plus the pane must still be waiting.
    launchAgentTabShortcut(worktreeId, resolved, () => {
      const latest = useAppStore.getState()
      return (
        latest.activeWorktreeId === worktreeId &&
        getDetectionTargetIdentityForWorktree(latest, worktreeId) === detectionTarget &&
        groupStillEmpty(worktreeId, groupId)
      )
    })
  }

  return (
    <CommandItem value="default-agent" selection="palette" onSelect={launchDefault}>
      {defaultAgent ? <AgentIcon agent={defaultAgent} size={16} /> : <Bot />}
      <span className="min-w-0 truncate">{label}</span>
      <DropdownMenu open={pickerOpen} onOpenChange={onPickerOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('components.tabGroup.splitPaneLanding.chooseAgent', 'Choose agent')}
            className="-ml-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground"
            // Why: the row's own click launches the default agent; the chevron only opens the list.
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-64"
          // Why: the portaled menu still bubbles through React to the row, whose click launches the default.
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            onPickerClosed()
          }}
        >
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={groupId}
            onFocusTerminal={focusTerminalTabSurface}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="flex-1" />
      <LandingItemShortcut label={shortcut} />
    </CommandItem>
  )
}

/** Every launchable agent matching the query, from the same rows as the + menu. */
export function LandingAgentResults({
  worktreeId,
  groupId,
  query,
  onResultsChange
}: {
  worktreeId: string
  groupId: string
  query: string
  onResultsChange: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const model = useNewTabAgentMenuRows(worktreeId, true, detectionTarget)
  const runLaunch = useTabAgentMenuLaunch({
    worktreeId,
    groupId,
    onFocusTerminal: focusTerminalTabSurface
  })
  const catalog = getAgentCatalog()
  const matches =
    model.state === 'settled'
      ? model.rows.filter((row) => {
          if (row.kind === 'chat-unavailable') {
            return false
          }
          const entry = catalog.find((candidate) => candidate.id === row.agent)
          return [rowLabel(row, t), ...(entry?.searchAliases ?? [])].some((candidate) =>
            landingQueryMatches(candidate, query)
          )
        })
      : []
  useLandingResultsChange(matches.map(rowId), onResultsChange)
  if (matches.length === 0) {
    return null
  }
  return (
    <CommandGroup heading={t('components.tabGroup.splitPaneLanding.agents', 'Agents')}>
      {matches.map((row) => (
        <CommandItem
          key={rowId(row)}
          value={`agent:${rowId(row)}`}
          selection="palette"
          onSelect={() => runLaunch(row)}
        >
          <AgentIcon agent={row.agent} size={16} />
          <span className="min-w-0 flex-1 truncate">{rowLabel(row, t)}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

function groupStillEmpty(worktreeId: string, groupId: string): boolean {
  const group = (useAppStore.getState().groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  return group !== undefined && group.tabOrder.length === 0
}
