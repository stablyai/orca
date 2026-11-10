import { useRef, useState } from 'react'
import { FilePlus, Globe, Smartphone, TerminalSquare, type LucideIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
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
import { useFileListWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { LandingAgentResults, LandingDefaultAgentItem } from './split-pane-landing-agents'
import { LandingFileResults } from './split-pane-landing-files'
import { LandingItemShortcut, landingQueryMatches } from './split-pane-landing-item'

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
  const [selected, setSelected] = useState('')
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const worktreePath = useFileListWorktree(worktreeId)?.path ?? null
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
  const terminalShortcut = useOptionalShortcutLabel('tab.newTerminal')
  const browserShortcut = useOptionalShortcutLabel('tab.newBrowser')
  const markdownShortcut = useOptionalShortcutLabel('tab.newMarkdown')
  const emulatorShortcut = useOptionalShortcutLabel('tab.newSimulator')

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

  const actions: LandingAction[] = [
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
    emulatorEnabled
      ? {
          id: 'emulator',
          icon: Smartphone,
          label: t('components.tabGroup.splitPaneLanding.mobileEmulator', 'Mobile emulator'),
          shortcut: emulatorShortcut,
          onSelect: openEmulator
        }
      : null
  ].filter(
    (action): action is LandingAction => action !== null && landingQueryMatches(action.label, query)
  )
  const searching = query.trim() !== ''

  // Why: cmdk pulls focus into its input on every selection change, so the list keeps focus
  // outside the Command root and drives its selection here; / moves into the field.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const input = inputRef.current
    if (event.target === input) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (query !== '') {
          setQuery('')
        } else {
          listRef.current?.focus()
        }
      }
      return
    }
    if (event.target !== listRef.current) {
      return
    }
    if (event.key === '/') {
      event.preventDefault()
      input?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(stepLandingSelection(listRef.current, selected, event.key === 'ArrowDown'))
    } else if (event.key === 'ArrowRight' && selected === 'default-agent') {
      event.preventDefault()
      setAgentPickerOpen(true)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      listRef.current.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')?.click()
    }
  }

  return (
    <div className="absolute inset-0 overflow-auto scrollbar-sleek bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-4 py-10">
        <div
          ref={listRef}
          tabIndex={-1}
          autoFocus={autoFocus}
          className="outline-none"
          onKeyDown={onKeyDown}
        >
          <Command
            surface="inline"
            shouldFilter={false}
            loop
            value={selected}
            onValueChange={setSelected}
            className="h-auto overflow-visible"
          >
            <CommandInput
              ref={inputRef}
              variant="framed"
              value={query}
              onValueChange={setQuery}
              placeholder={t(
                'components.tabGroup.splitPaneLanding.searchPlaceholder',
                'Open agent, terminal, or file…'
              )}
            />
            <CommandList className="mt-2 h-72">
              <CommandEmpty>
                {t('components.tabGroup.splitPaneLanding.noMatches', 'No matches')}
              </CommandEmpty>
              {searching ? (
                <LandingAgentResults worktreeId={worktreeId} groupId={groupId} query={query} />
              ) : null}
              {!searching || actions.length > 0 ? (
                <CommandGroup heading={t('components.tabGroup.splitPaneLanding.new', 'New')}>
                  {searching ? null : (
                    <LandingDefaultAgentItem
                      worktreeId={worktreeId}
                      groupId={groupId}
                      pickerOpen={agentPickerOpen}
                      onPickerOpenChange={setAgentPickerOpen}
                      onPickerClosed={() => listRef.current?.focus()}
                    />
                  )}
                  {actions.map((action) => (
                    <CommandItem
                      key={action.id}
                      value={action.id}
                      selection="palette"
                      onSelect={action.onSelect}
                    >
                      <action.icon className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{action.label}</span>
                      <LandingItemShortcut label={action.shortcut} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {worktreePath ? (
                <LandingFileResults
                  worktreeId={worktreeId}
                  worktreePath={worktreePath}
                  query={query}
                />
              ) : null}
            </CommandList>
          </Command>
        </div>
        <div className="mt-3 flex items-center justify-between px-2 text-xs text-muted-foreground">
          <span>
            {t(
              'components.tabGroup.splitPaneLanding.keyboardHint',
              '↑↓ Enter to open · → agents · / to search'
            )}
          </span>
          {onClosePane ? (
            <Button type="button" variant="ghost" size="xs" onClick={onClosePane}>
              <span className="text-muted-foreground">
                {t('components.tabGroup.splitPaneLanding.closePane', 'Close pane')}
              </span>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

type LandingAction = {
  id: string
  icon: LucideIcon
  label: string
  shortcut: string | null
  onSelect: () => void
}

function stepLandingSelection(list: HTMLElement, current: string, forward: boolean): string {
  const values = Array.from(
    list.querySelectorAll<HTMLElement>('[cmdk-item]:not([data-disabled="true"])'),
    (item) => item.dataset.value ?? ''
  )
  if (values.length === 0) {
    return current
  }
  const index = values.indexOf(current)
  const next = index === -1 ? 0 : (index + (forward ? 1 : -1) + values.length) % values.length
  return values[next] ?? current
}
