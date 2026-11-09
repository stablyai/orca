import { useRef } from 'react'
import {
  FilePlus,
  Globe,
  History,
  Search,
  Smartphone,
  TerminalSquare,
  type LucideIcon
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { useShortcutKeyDetails, type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import {
  ensureClientCreationActionAllowed,
  showClientCreationActionError
} from '@/lib/client-creation-action-error'
import { openNewTerminalTabInWorkspace } from '@/store/terminals/terminal-active-workspace-creation'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { openMobileEmulatorTab } from '@/lib/simulator/launch/open-mobile-emulator-tab'
import {
  ensureSimulatorTab,
  getSimulatorTabForWorktree
} from '@/lib/simulator/tabs/ensure-simulator-tab'
import { Button } from '@/components/ui/button'
import { SplitPaneLandingAgentRow } from './SplitPaneLandingAgentRow'
import { LandingRowLabel, LandingRowShortcut, moveLandingRowFocus } from './split-pane-landing-row'

/** Fills an empty split pane so the user picks what opens there; each action creates into this group. */
export function SplitPaneLanding({
  worktreeId,
  groupId,
  autoFocus,
  onClosePane
}: {
  worktreeId: string
  groupId: string
  autoFocus: boolean
  /** Absent when this is the workspace's only pane. */
  onClosePane: (() => void) | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const listRef = useRef<HTMLDivElement>(null)
  // Why: paired web clients without host streaming hide these, as the tab bar's + menu does.
  const [browserEnabled, emulatorEnabled] = useAppStore(
    useShallow((state) => {
      const policy = getWorkspaceClientCreationActionPolicy(state, worktreeId)
      return [
        policy['managed-browser'].state === 'enabled',
        state.settings?.mobileEmulatorEnabled !== false &&
          policy['mobile-emulator'].state === 'enabled'
      ] as const
    })
  )
  const canReopen = useAppStore(
    (state) => (state.recentlyClosedTabKindsByWorktree[worktreeId]?.length ?? 0) > 0
  )
  const terminalShortcut = useShortcutKeyDetails('tab.newTerminal')
  const browserShortcut = useShortcutKeyDetails('tab.newBrowser')
  const markdownShortcut = useShortcutKeyDetails('tab.newMarkdown')
  const quickOpenShortcut = useShortcutKeyDetails('worktree.quickOpen')
  const emulatorShortcut = useShortcutKeyDetails('tab.newSimulator')
  const reopenShortcut = useShortcutKeyDetails('tab.reopenClosed')

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
  const openMarkdown = (): void => {
    void useAppStore
      .getState()
      .openNewMarkdownInActiveWorkspace(groupId)
      .catch(showClientCreationActionError)
  }
  const openEmulator = (): void => {
    // A workspace has one emulator; the + menu brings an existing one forward the same way.
    if (getSimulatorTabForWorktree(worktreeId)) {
      void ensureSimulatorTab(worktreeId, { surfacePane: true })
      return
    }
    void openMobileEmulatorTab(worktreeId, { targetGroupId: groupId }).catch(
      showClientCreationActionError
    )
  }

  const rows: LandingRow[] = [
    {
      id: 'terminal',
      icon: TerminalSquare,
      label: t('components.tabGroup.splitPaneLanding.terminal', 'Terminal'),
      shortcut: terminalShortcut,
      onSelect: openTerminal
    },
    browserEnabled
      ? {
          id: 'browser',
          icon: Globe,
          label: t('components.tabGroup.splitPaneLanding.browser', 'Browser'),
          shortcut: browserShortcut,
          onSelect: openBrowser
        }
      : null,
    {
      id: 'markdown',
      icon: FilePlus,
      label: t('components.tabGroup.splitPaneLanding.markdown', 'Markdown'),
      shortcut: markdownShortcut,
      onSelect: openMarkdown
    },
    {
      id: 'quick-open',
      icon: Search,
      label: t('components.tabGroup.splitPaneLanding.goToFile', 'Go to file'),
      shortcut: quickOpenShortcut,
      onSelect: () => useAppStore.getState().openModal('quick-open')
    },
    emulatorEnabled
      ? {
          id: 'emulator',
          icon: Smartphone,
          label: t('components.tabGroup.splitPaneLanding.mobileEmulator', 'Mobile emulator'),
          shortcut: emulatorShortcut,
          onSelect: openEmulator
        }
      : null
  ].filter((row): row is LandingRow => row !== null)

  return (
    <div className="absolute inset-0 overflow-auto scrollbar-sleek bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-4 py-10">
        <div className="mb-3 text-sm text-muted-foreground">
          {t('components.tabGroup.splitPaneLanding.heading', 'Open in this pane')}
        </div>
        <div
          ref={listRef}
          className="flex flex-col gap-2"
          onKeyDown={(event) => moveLandingRowFocus(event, listRef.current)}
        >
          <SplitPaneLandingAgentRow
            worktreeId={worktreeId}
            groupId={groupId}
            autoFocus={autoFocus}
          />
          {rows.map((row) => (
            <LandingRowButton key={row.id} row={row} />
          ))}
          {canReopen ? (
            <>
              <div className="my-1 h-px bg-border" />
              <LandingRowButton
                row={{
                  id: 'reopen',
                  icon: History,
                  label: t(
                    'components.tabGroup.splitPaneLanding.reopenClosedTab',
                    'Reopen closed tab'
                  ),
                  shortcut: reopenShortcut,
                  onSelect: () => useAppStore.getState().reopenClosedTab(worktreeId)
                }}
              />
            </>
          ) : null}
        </div>
        {onClosePane ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-4 self-center"
            onClick={onClosePane}
          >
            <span className="text-muted-foreground">
              {t('components.tabGroup.splitPaneLanding.closePane', 'Close pane')}
            </span>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type LandingRow = {
  id: string
  icon: LucideIcon
  label: string
  shortcut: ShortcutKeyComboDetails
  onSelect: () => void
}

function LandingRowButton({ row }: { row: LandingRow }): React.JSX.Element {
  const Icon = row.icon
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      data-landing-row
      className="w-full justify-start"
      onClick={row.onSelect}
    >
      <Icon className="text-muted-foreground" />
      <LandingRowLabel label={row.label} />
      <LandingRowShortcut shortcut={row.shortcut} />
    </Button>
  )
}
