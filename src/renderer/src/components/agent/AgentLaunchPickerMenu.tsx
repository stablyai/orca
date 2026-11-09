import {
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react'
import { useAppStore } from '@/store/index'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { Input } from '@/components/ui/input'
import { Terminal } from 'lucide-react'
import { agentPickerBlankTerminalMatches } from '@/lib/agent-picker-search'
import { AgentDefaultContextMenu } from './agent-combobox-items'
import { AgentPickerMenuRow, type AgentPickerMenuLaunch } from './AgentLaunchPickerMenuRow'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { retireAgentPickerDrafts, type AgentPickerSetupIdentity } from './AgentLaunchSetupButton'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from './use-agent-launch-picker-inventory'
import { searchAgentPickerSetups } from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

export function AgentLaunchPickerMenu({
  model,
  draftScope,
  shortcutLabels,
  disabled,
  setupDisabled,
  mode,
  value,
  draftForEntry,
  runLaunch,
  entries,
  hideSearch,
  initialQuery = '',
  searchInputRef,
  onSelectAgent,
  defaultAgent,
  onSetDefault,
  onSelectBlankTerminal,
  leadingItems
}: {
  model?: NewTabAgentMenuModel
  draftScope?: object
  shortcutLabels?: ReadonlyMap<AgentPickerEntry['agent'], string>
  disabled?: boolean
  setupDisabled?: boolean
  mode?: 'launch' | 'select'
  value?: AgentPickerDraft
  draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
  runLaunch: AgentPickerMenuLaunch
  entries: AgentPickerEntry[]
  hideSearch?: boolean
  /** Seeds the search field; read once when the menu mounts. */
  initialQuery?: string
  /** A supplied ref gives the owning popup control of initial focus. */
  searchInputRef?: Ref<HTMLInputElement>
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
  defaultAgent?: AgentPickerEntry['agent'] | 'blank' | null
  onSetDefault?: (agent: AgentPickerEntry['agent'] | 'blank') => void
  onSelectBlankTerminal?: () => void
  leadingItems?: ReactNode
}) {
  const t = useTranslate()
  useEffect(() => {
    if (setupDisabled) {
      return
    }
    const state = useAppStore.getState()
    const workspaces = new Set([
      ...Object.values(selectWorktreesByRepo(state) ?? {})
        .flat()
        .map((row) => row.id),
      ...(selectFolderWorkspaces(state) ?? []).map((row) => `folder:${row.id}`)
    ])
    const repos = new Set((state.repos ?? []).map((repo) => repo.id))
    retireAgentPickerDrafts(
      entries,
      draftScope,
      (target) => {
        const host = parseExecutionHostId(target.executionHostId)
        return (
          !(
            host?.kind === 'runtime' && state.removedRuntimeEnvironmentIds?.has(host.environmentId)
          ) &&
          (!target.worktreeId || workspaces.has(target.worktreeId)) &&
          (!target.repoId || repos.has(target.repoId))
        )
      },
      mode
    )
  }, [entries, draftScope, mode, setupDisabled])
  const terminalBlocked = mode !== 'select' && model?.state === 'settled' && model.terminalPending
  const [query, setQuery] = useState(initialQuery)
  const [searchFocused, setSearchFocused] = useState(false)
  const [activeSetup, setActiveSetup] = useState<{
    id: string
    agent: AgentPickerEntry['agent']
    preset?: AgentPickerSetupIdentity
    label: string
  } | null>(null)
  const openSetup = activeSetup?.id ?? null
  const root = useRef<HTMLDivElement>(null)
  const setups = setupDisabled ? [] : searchAgentPickerSetups(entries, query)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = entries.filter((entry) =>
    words.every((word) => `${entry.agent} ${entry.label}`.toLowerCase().includes(word))
  )
  // Filtering changes presentation; an active owner survives its result row disappearing.
  if (activeSetup) {
    const entry = entries.find((entry) => entry.agent === activeSetup.agent)
    if (
      entry &&
      activeSetup.preset &&
      !setups.some(
        (setup) =>
          setup.entry.agent === entry.agent &&
          setup.model.id === activeSetup.preset?.model &&
          setup.choices.options?.effort === activeSetup.preset.effort
      )
    ) {
      setups.push({
        entry,
        model: {
          id: activeSetup.preset.model,
          label: activeSetup.label,
          isDefault: false,
          efforts: []
        },
        label: activeSetup.label,
        choices: {
          model: activeSetup.preset.model,
          ...(activeSetup.preset.effort ? { options: { effort: activeSetup.preset.effort } } : {})
        }
      })
    } else if (entry && !activeSetup.preset && !visible.includes(entry)) {
      visible.push(entry)
    }
  }
  // Why: Enter in the search picks the first enabled row, so show it highlighted like cmdk comboboxes.
  const enabled = (entry: AgentPickerEntry) => !disabled && entry.surfaces.length > 0
  const showBlankTerminal = !!onSelectBlankTerminal && agentPickerBlankTerminalMatches(query)
  // Why: a query naming an agent ("codex") should surface that agent before other agents' model setups.
  const firstEntry = showBlankTerminal ? undefined : visible.find(enabled)
  const firstSetup =
    showBlankTerminal || firstEntry ? undefined : setups.find((setup) => enabled(setup.entry))
  const showSearchDefault = searchFocused && query.trim().length > 0
  return (
    <div ref={root} data-agent-launch-picker="true">
      {!hideSearch ? (
        <div className="px-1 pt-0.5 pb-1.5">
          <Input
            ref={searchInputRef}
            value={query}
            autoFocus={!searchInputRef}
            onBlur={() => setSearchFocused(false)}
            onFocus={(event) => {
              setSearchFocused(true)
              // Why: a seeded query must keep the caret after the typed key.
              const end = event.currentTarget.value.length
              event.currentTarget.setSelectionRange(end, end)
            }}
            placeholder={
              setupDisabled
                ? t('agentPicker.searchAgents', 'Search agents…')
                : t('agentPicker.search', 'Search, e.g. Opus 5.5…')
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                return
              }
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault()
                const results =
                  event.key === 'Enter'
                    ? '[data-agent-picker-agent-results]'
                    : '[data-agent-picker-results]'
                const first = root.current?.querySelector<HTMLElement>(
                  `${results} [role="menuitem"]:not([data-disabled])`
                )
                if (event.key === 'Enter') {
                  first?.click()
                } else {
                  first?.focus()
                }
              }
            }}
          />
        </div>
      ) : null}
      <div data-agent-picker-results className="max-h-64 overflow-y-auto scrollbar-sleek">
        {leadingItems}
        <div data-agent-picker-agent-results>
          {showBlankTerminal ? (
            <AgentDefaultContextMenu
              isDefault={defaultAgent === 'blank'}
              onSetDefault={onSetDefault ? () => onSetDefault('blank') : undefined}
            >
              <DropdownMenuItem
                variant="launch"
                className="h-9"
                disabled={disabled}
                data-search-default={showSearchDefault || undefined}
                onSelect={onSelectBlankTerminal}
              >
                <Terminal className="size-4" />
                {t('auto.components.agent.AgentCombobox.986f946354', 'Blank Terminal')}
              </DropdownMenuItem>
            </AgentDefaultContextMenu>
          ) : null}
          {visible.map((entry) => {
            const source = draftForEntry?.(entry)
            return (
              <AgentPickerMenuRow
                key={entry.agent}
                draftScope={draftScope}
                entry={entry}
                mode={mode}
                searchDefault={showSearchDefault && entry === firstEntry}
                source={source}
                selected={value?.agent === entry.agent ? value : undefined}
                setupDisabled={setupDisabled}
                openSetup={openSetup}
                onSetupOpenChange={setActiveSetup}
                disabled={disabled}
                terminalBlocked={terminalBlocked}
                runLaunch={runLaunch}
                onSelectAgent={onSelectAgent}
                isDefault={defaultAgent === entry.agent}
                onSetDefault={onSetDefault}
                shortcut={mode !== 'select' ? shortcutLabels?.get(entry.agent) : undefined}
              />
            )
          })}
          {setups.map((setup) => {
            const source = draftForEntry?.(setup.entry)
            return (
              <AgentPickerMenuRow
                key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
                draftScope={draftScope}
                draftId={`${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
                initialModel={setup.model.id}
                initialEffort={setup.choices.options?.effort}
                entry={setup.entry}
                mode={mode}
                setupDisabled={setupDisabled}
                openSetup={openSetup}
                onSetupOpenChange={setActiveSetup}
                label={setup.label}
                searchDefault={showSearchDefault && setup === firstSetup}
                source={source}
                selected={value?.agent === setup.entry.agent ? value : undefined}
                onSelectAgent={onSelectAgent}
                disabled={disabled}
                terminalBlocked={terminalBlocked}
                runLaunch={runLaunch}
              />
            )
          })}
          {!showBlankTerminal && !visible.length && !setups.length ? (
            <DropdownMenuItem disabled>
              {t('auto.components.agent.AgentCombobox.579c768bde', 'No agents match your search.')}
            </DropdownMenuItem>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// Subscribe here so inventory updates do not re-render the tab bar.
export function SubscribedAgentLaunchPickerMenu({
  inventory,
  ...props
}: Omit<ComponentProps<typeof AgentLaunchPickerMenu>, 'entries'> & {
  inventory: AgentPickerInventorySource
}) {
  const entries = useAgentPickerInventoryEntries(inventory)
  return <AgentLaunchPickerMenu {...props} entries={entries} />
}
