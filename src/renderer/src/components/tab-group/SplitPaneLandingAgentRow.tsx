import { Bot, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../store'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getDetectionTargetIdentityForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { QuickLaunchAgentMenuItems } from '../tab-bar/QuickLaunchButton'
import {
  readNewAgentTabDefault,
  resolveTerminalAgentTabShortcut
} from '../terminal-agent-tab-shortcut'
import { launchAgentTabShortcut } from '../agent-tab-shortcut-launch'
import { LANDING_ROW_CLASS, LandingRowShortcut } from './split-pane-landing-row'

/** The default agent as one row; the chevron opens the + menu's agent list for any other. */
export function SplitPaneLandingAgentRow({
  worktreeId,
  groupId,
  autoFocus
}: {
  worktreeId: string
  groupId: string
  autoFocus: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const defaultAgent = useAppStore((state) => readNewAgentTabDefault(state, worktreeId))
  const shortcut = useShortcutKeyDetails('tab.newAgent')
  const label = defaultAgent
    ? (getAgentCatalog().find((entry) => entry.id === defaultAgent)?.label ?? defaultAgent)
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
    // Why: a stretched button keeps the row one click target while the chevron stays its own button.
    <div
      className={cn(
        LANDING_ROW_CLASS,
        'relative has-[[data-landing-row]:focus-visible]:bg-accent has-[[data-landing-row]:focus-visible]:text-accent-foreground'
      )}
    >
      <button
        type="button"
        data-landing-row
        aria-label={label}
        className="absolute inset-0 rounded-md focus-visible:outline-none"
        onClick={launchDefault}
        autoFocus={autoFocus}
      />
      <span className="pointer-events-none flex text-muted-foreground">
        {defaultAgent ? <AgentIcon agent={defaultAgent} size={16} /> : <Bot className="size-4" />}
      </span>
      <span className="pointer-events-none min-w-0 truncate">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('components.tabGroup.splitPaneLanding.chooseAgent', 'Choose agent')}
            className="relative -ml-1.5 flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="w-64">
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={groupId}
            onFocusTerminal={focusTerminalTabSurface}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="pointer-events-none ml-auto flex">
        <LandingRowShortcut shortcut={shortcut} />
      </span>
    </div>
  )
}

function groupStillEmpty(worktreeId: string, groupId: string): boolean {
  const group = (useAppStore.getState().groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  return group !== undefined && group.tabOrder.length === 0
}
