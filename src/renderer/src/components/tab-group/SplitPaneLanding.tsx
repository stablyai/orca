import { useCallback, useRef, useState } from 'react'
import { FilePlus, Globe, Smartphone, TerminalSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store/index'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import {
  ensureClientCreationActionAllowed,
  showClientCreationActionError
} from '@/lib/workspace/creation/surface-policy/client-creation-action-error'
import { openNewTerminalTabInWorkspace } from '@/store/terminals/terminal-active-workspace-creation'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { openMobileEmulatorTab } from '@/lib/simulator/launch/open-mobile-emulator-tab'
import {
  ensureSimulatorTab,
  getSimulatorTabForWorktree
} from '@/lib/simulator/tabs/ensure-simulator-tab'
import { useFileListWorktree } from '@/store/workspaces/selection/use-selected-worktree'
import { useMeasuredWidth } from '@/components/right-sidebar/right-sidebar-measured-width'
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
  const [selected, setSelected] = useState('default-agent')
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  // Why: a highlight the user moved since the last query is their choice; late results must not take it back.
  const highlightMovedRef = useRef(false)
  // Why: the full placeholder clips once a narrow card is focused; a placeholder can't follow a container query, so measure.
  const [narrowCard, setNarrowCard] = useState(false)
  const measureCard = useMeasuredWidth(
    useCallback(
      (width: number | null) => setNarrowCard(width !== null && width < NARROW_CARD_WIDTH),
      []
    )
  )
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
  const searchLabel = t(
    'components.tabGroup.splitPaneLanding.searchAgentsAndFiles',
    'Search agents and files'
  )

  const changeSelected = (next: string): void => {
    // Why: cmdk falls back to the first row when the highlighted row unmounts; the user's pick is gone, so late rows lead again.
    if (highlightMovedRef.current && !listHasRow(listRef.current, selected)) {
      highlightMovedRef.current = false
    }
    setSelected(next)
  }

  const changeQuery = (next: string): void => {
    highlightMovedRef.current = false
    setQuery(next)
  }

  // Why: cmdk keeps its value when rows mount later, so a fast Enter would open a row the user never saw highlighted.
  const highlightFirstRow = (): void => {
    if (highlightMovedRef.current) {
      return
    }
    const first = listRef.current?.querySelector<HTMLElement>(
      '[cmdk-item]:not([aria-disabled="true"])'
    )
    if (first?.dataset.value) {
      setSelected(first.dataset.value)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight' && query === '' && selected === 'default-agent') {
      event.preventDefault()
      setAgentPickerOpen(true)
    } else if (event.key === 'Escape' && query !== '') {
      event.preventDefault()
      changeQuery('')
    } else if (movesLandingHighlight(event)) {
      highlightMovedRef.current = true
    }
  }

  return (
    <div className="absolute inset-0 overflow-auto scrollbar-sleek bg-background">
      <div className="flex min-h-full w-full flex-col items-center justify-center px-4 py-10">
        <div ref={measureCard} className="split-pane-landing @container w-full max-w-[380px]">
          <Command
            density="card"
            label={searchLabel}
            shouldFilter={false}
            loop
            value={selected}
            onValueChange={changeSelected}
            onKeyDown={onKeyDown}
            className="h-auto overflow-hidden"
          >
            <CommandInput
              ref={inputRef}
              autoFocus={autoFocus}
              value={query}
              onValueChange={changeQuery}
              placeholder={
                narrowCard
                  ? t('components.tabGroup.splitPaneLanding.searchShort', 'Search')
                  : searchLabel
              }
            />
            <CommandList
              ref={listRef}
              onPointerMove={(event) => {
                if (event.target instanceof Element && event.target.closest('[cmdk-item]')) {
                  highlightMovedRef.current = true
                }
              }}
            >
              <CommandEmpty>
                {t('components.tabGroup.splitPaneLanding.noMatches', 'No matches')}
              </CommandEmpty>
              {searching ? (
                <LandingAgentResults
                  worktreeId={worktreeId}
                  groupId={groupId}
                  query={query}
                  onResultsChange={highlightFirstRow}
                />
              ) : null}
              {!searching || actions.length > 0 ? (
                <CommandGroup
                  heading={
                    searching ? t('components.tabGroup.splitPaneLanding.new', 'New') : undefined
                  }
                >
                  {searching ? null : (
                    <LandingDefaultAgentItem
                      worktreeId={worktreeId}
                      groupId={groupId}
                      pickerOpen={agentPickerOpen}
                      onPickerOpenChange={setAgentPickerOpen}
                      onPickerClosed={() => inputRef.current?.focus()}
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
                  onResultsChange={highlightFirstRow}
                />
              ) : null}
            </CommandList>
          </Command>
          {onClosePane ? (
            <div className="mt-3 flex justify-center">
              <Button type="button" variant="ghost" size="xs" onClick={onClosePane}>
                <span className="text-muted-foreground">
                  {t('components.tabGroup.splitPaneLanding.closePane', 'Close pane')}
                </span>
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Focused placeholders do not ellipsize in Chromium. */
const NARROW_CARD_WIDTH = 300

type LandingAction = {
  id: string
  icon: LucideIcon
  label: string
  shortcut: string | null
  onSelect: () => void
}

function listHasRow(list: HTMLElement | null, value: string): boolean {
  return Array.from(list?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? []).some(
    (row) => row.dataset.value === value
  )
}

/** The keys cmdk moves its highlight with (vim bindings included). */
function movesLandingHighlight(event: React.KeyboardEvent): boolean {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    return true
  }
  return event.ctrlKey && ['n', 'j', 'p', 'k'].includes(event.key)
}
