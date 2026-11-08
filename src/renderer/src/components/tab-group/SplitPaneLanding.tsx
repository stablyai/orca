import { useMemo } from 'react'
import { Bot, Globe, TerminalSquare } from 'lucide-react'
import { useAppStore } from '../../store'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import {
  ensureClientCreationActionAllowed,
  showClientCreationActionError
} from '@/lib/client-creation-action-error'
import { openNewTerminalTabInWorkspace } from '@/store/terminals/terminal-active-workspace-creation'
import { resolveTerminalAgentTabShortcut } from '../terminal-agent-tab-shortcut'
import { launchAgentTabShortcut } from '../agent-tab-shortcut-launch'
import { getDetectionTargetIdentityForWorktree } from '@/lib/agent-detection-target-inventory'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import {
  LANDING_ACTION_BUTTON_CLASS,
  LandingBrand,
  LandingShortcutList,
  type LandingShortcutItem
} from '../landing-layout'

/** Fills an empty split pane so the user picks what opens there; each action creates into this group. */
export function SplitPaneLanding({
  worktreeId,
  groupId,
  autoFocus
}: {
  worktreeId: string
  groupId: string
  autoFocus: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const newAgentLabel = t('components.tabGroup.splitPaneLanding.newAgent', 'New Agent')
  const newTerminalLabel = t('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')
  const newBrowserLabel = t('auto.components.tab.bar.TabBar.4833fb2cbe', 'New Browser Tab')
  const newMarkdownLabel = t('auto.components.tab.bar.TabBar.3d5d6c960d', 'New Markdown')
  const closeLabel = t(
    'auto.components.tab.group.TabGroupPanel.closePaneColumn',
    'Close split pane'
  )

  // Why: paired web clients without browser streaming hide browser creation, as the tab menu does.
  const browserEnabled = useAppStore(
    (state) =>
      getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser'].state ===
      'enabled'
  )
  // A sole landing has no split to close; Close there leaves the workspace.
  const splitsWorkspace = useAppStore(
    (state) => (state.groupsByWorktree[worktreeId]?.length ?? 0) > 1
  )
  const newAgentShortcut = useShortcutKeyDetails('tab.newAgent')
  const newTerminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const newBrowserShortcut = useShortcutKeyDetails('tab.newBrowser')
  const newMarkdownShortcut = useShortcutKeyDetails('tab.newMarkdown')
  const closeShortcut = useShortcutKeyDetails('tab.close')
  const shortcuts = useMemo<LandingShortcutItem[]>(
    () =>
      [
        { id: 'agent', shortcut: newAgentShortcut, action: newAgentLabel },
        { id: 'terminal', shortcut: newTerminalShortcut, action: newTerminalLabel },
        browserEnabled
          ? { id: 'browser', shortcut: newBrowserShortcut, action: newBrowserLabel }
          : null,
        { id: 'markdown', shortcut: newMarkdownShortcut, action: newMarkdownLabel },
        splitsWorkspace ? { id: 'close', shortcut: closeShortcut, action: closeLabel } : null
      ].filter(
        (item): item is LandingShortcutItem => item !== null && item.shortcut.keys.length > 0
      ),
    [
      browserEnabled,
      closeLabel,
      closeShortcut,
      newAgentLabel,
      newAgentShortcut,
      newBrowserLabel,
      newBrowserShortcut,
      newMarkdownLabel,
      newMarkdownShortcut,
      newTerminalLabel,
      newTerminalShortcut,
      splitsWorkspace
    ]
  )

  const launchAgent = (): void => {
    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: worktreeId,
      keybindings: useAppStore.getState().keybindings,
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })
    const detectionTarget = getDetectionTargetIdentityForWorktree(
      useAppStore.getState(),
      worktreeId
    )
    // Why: same cancellation as the keyboard shortcut, plus the pane must still be waiting.
    launchAgentTabShortcut(worktreeId, shortcut, () => {
      const latest = useAppStore.getState()
      return (
        latest.activeWorktreeId === worktreeId &&
        getDetectionTargetIdentityForWorktree(latest, worktreeId) === detectionTarget &&
        groupStillEmpty(worktreeId, groupId)
      )
    })
  }
  const openTerminal = (): void => {
    void openNewTerminalTabInWorkspace(useAppStore.getState, worktreeId, groupId).catch(
      showClientCreationActionError
    )
  }
  const openBrowser = (): void => {
    if (!ensureClientCreationActionAllowed(worktreeId, 'managed-browser')) {
      return
    }
    void useAppStore
      .getState()
      .openNewBrowserTabInActiveWorkspace(groupId)
      .catch(showClientCreationActionError)
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto scrollbar-sleek bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <LandingBrand />
          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button
              type="button"
              className={LANDING_ACTION_BUTTON_CLASS}
              onClick={launchAgent}
              autoFocus={autoFocus}
            >
              <Bot className="size-3.5" />
              {newAgentLabel}
            </button>
            <button type="button" className={LANDING_ACTION_BUTTON_CLASS} onClick={openTerminal}>
              <TerminalSquare className="size-3.5" />
              {newTerminalLabel}
            </button>
            {browserEnabled ? (
              <button type="button" className={LANDING_ACTION_BUTTON_CLASS} onClick={openBrowser}>
                <Globe className="size-3.5" />
                {newBrowserLabel}
              </button>
            ) : null}
          </div>
          <LandingShortcutList shortcuts={shortcuts} />
        </div>
      </div>
    </div>
  )
}

function groupStillEmpty(worktreeId: string, groupId: string): boolean {
  const group = (useAppStore.getState().groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  return group !== undefined && group.tabOrder.length === 0
}
