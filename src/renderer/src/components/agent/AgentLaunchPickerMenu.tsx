import { selectWorktreesByRepo, selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { useEffect, useRef, useState, type ComponentProps, type Ref } from 'react'
import { useAppStore } from '@/store/index'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { Input } from '@/components/ui/input'
import { AgentPickerMenuRow, type AgentPickerMenuLaunch } from './AgentLaunchPickerMenuRow'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
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
  onSetDefault
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
  onSetDefault?: (agent: AgentPickerEntry['agent']) => void
}) {
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
  const firstSetup = setups.find((setup) => enabled(setup.entry))
  const firstEntry = firstSetup ? undefined : visible.find(enabled)
  const showSearchDefault = searchFocused && query.trim().length > 0
  return (
    <div ref={root} data-agent-launch-picker="true">
      {!hideSearch ? (
        <div className="px-1 py-0.5">
          <Input
            ref={searchInputRef}
            value={query}
            density="compact"
            autoFocus={!searchInputRef}
            onBlur={() => setSearchFocused(false)}
            onFocus={(event) => {
              setSearchFocused(true)
              // Why: a seeded query must keep the caret after the typed key.
              const end = event.currentTarget.value.length
              event.currentTarget.setSelectionRange(end, end)
            }}
            placeholder={translate('agentPicker.search', 'Search agents and setups…')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                return
              }
              event.stopPropagation()
              if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault()
                const first = root.current?.querySelector<HTMLElement>(
                  '[role="menuitem"]:not([data-disabled])'
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
      <div className="max-h-64 overflow-y-auto scrollbar-sleek">
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
              runLaunch={runLaunch}
            />
          )
        })}
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
              runLaunch={runLaunch}
              onSelectAgent={onSelectAgent}
              isDefault={defaultAgent === entry.agent}
              onSetDefault={onSetDefault}
              shortcut={mode !== 'select' ? shortcutLabels?.get(entry.agent) : undefined}
            />
          )
        })}
        {!visible.length && !setups.length ? (
          <DropdownMenuItem disabled>
            {translate(
              'auto.components.agent.AgentCombobox.579c768bde',
              'No agents match your search.'
            )}
          </DropdownMenuItem>
        ) : null}
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
