import { Bot, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../store'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
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
import { LandingRowLabel, LandingRowShortcut } from './split-pane-landing-row'

/** The default agent as a split button; the chevron opens the + menu's agent list for any other. */
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
    <ButtonGroup className="w-full">
      <Button
        type="button"
        variant="outline"
        size="lg"
        data-landing-row
        className="min-w-0 flex-1 justify-start"
        onClick={launchDefault}
        autoFocus={autoFocus}
      >
        {defaultAgent ? <AgentIcon agent={defaultAgent} size={16} /> : <Bot />}
        <LandingRowLabel label={label} />
        <LandingRowShortcut shortcut={shortcut} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label={t('components.tabGroup.splitPaneLanding.chooseAgent', 'Choose agent')}
          >
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-64">
          <QuickLaunchAgentMenuItems
            worktreeId={worktreeId}
            groupId={groupId}
            onFocusTerminal={focusTerminalTabSurface}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}

function groupStillEmpty(worktreeId: string, groupId: string): boolean {
  const group = (useAppStore.getState().groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  return group !== undefined && group.tabOrder.length === 0
}
