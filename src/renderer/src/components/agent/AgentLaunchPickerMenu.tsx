import { selectWorktreesByRepo, selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { memo, useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { useAppStore } from '@/store/index'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  AgentLaunchSetupButton,
  retireAgentPickerDrafts,
  type AgentPickerSetupIdentity
} from './AgentLaunchSetupButton'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import {
  ClaudeConfigProfileMenuItems,
  useClaudeConfigProfilePickerRows
} from './ClaudeConfigProfileMenuItems'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from './use-agent-launch-picker-inventory'
import { searchAgentPickerSetups } from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

export function pickerLaunchRow(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface
): NewTabAgentMenuRow {
  return {
    agent: entry.agent,
    kind: surface === 'chat' ? 'chat' : 'cli',
    executionHostId: entry.rows[0]?.executionHostId
  }
}

type Launch = (
  row: NewTabAgentMenuRow,
  draft?: AgentPickerDraft,
  entry?: AgentPickerEntry,
  /** Select mode: the surface explicitly accepted by a named launch action. */
  surface?: AgentPickerSurface
) => boolean | void | Promise<boolean>

/** Searchable agent list with setup submenus; launch mode also lists Claude profile rows. */
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
  onSelectAgent
}: {
  model?: NewTabAgentMenuModel
  draftScope?: object
  shortcutLabels?: ReadonlyMap<AgentPickerEntry['agent'], string>
  disabled?: boolean
  setupDisabled?: boolean
  mode?: 'launch' | 'select'
  value?: AgentPickerDraft
  draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
  runLaunch: Launch
  entries: AgentPickerEntry[]
  hideSearch?: boolean
  /** Seeds the search field; read once when the menu mounts. */
  initialQuery?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  useEffect(() => {
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
  }, [entries, draftScope, mode])
  const [query, setQuery] = useState(initialQuery)
  const [activeSetup, setActiveSetup] = useState<{
    id: string
    agent: AgentPickerEntry['agent']
    preset?: AgentPickerSetupIdentity
    label: string
  } | null>(null)
  const openSetup = activeSetup?.id ?? null
  const root = useRef<HTMLDivElement>(null)
  const setups = searchAgentPickerSetups(entries, query)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = entries.filter((entry) =>
    words.every((word) => `${entry.agent} ${entry.label}`.toLowerCase().includes(word))
  )
  const profileRows = useClaudeConfigProfilePickerRows(mode === 'select' ? [] : entries, words)
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
  return (
    <div ref={root} data-agent-launch-picker="true">
      {!hideSearch ? (
        <div className="px-1 py-0.5">
          <Input
            value={query}
            density="compact"
            autoFocus
            onFocus={(event) => {
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
              source={source}
              selected={value?.agent === entry.agent ? value : undefined}
              setupDisabled={setupDisabled}
              openSetup={openSetup}
              onSetupOpenChange={setActiveSetup}
              disabled={disabled}
              runLaunch={runLaunch}
              onSelectAgent={onSelectAgent}
              shortcut={mode !== 'select' ? shortcutLabels?.get(entry.agent) : undefined}
            />
          )
        })}
        <ClaudeConfigProfileMenuItems
          rows={profileRows}
          disabled={disabled}
          runLaunch={runLaunch}
        />
        {!visible.length && !setups.length && !profileRows.length ? (
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

// Why: catalog and seed reads land one agent at a time after the menu opens; only that row re-renders.
const AgentPickerMenuRow = memo(function AgentPickerMenuRow({
  entry,
  draftScope,
  draftId,
  initialModel,
  initialEffort,
  openSetup,
  onSetupOpenChange,
  label = entry.label,
  source,
  selected,
  mode,
  setupDisabled,
  disabled,
  runLaunch,
  shortcut,
  onSelectAgent
}: {
  entry: AgentPickerEntry
  draftScope?: object
  draftId?: string
  initialModel?: string
  initialEffort?: string
  openSetup: string | null
  onSetupOpenChange: (
    setup: {
      id: string
      agent: AgentPickerEntry['agent']
      preset?: AgentPickerSetupIdentity
      label: string
    } | null
  ) => void
  label?: string
  source?: AgentPickerDraft
  selected?: AgentPickerDraft
  mode?: 'launch' | 'select'
  setupDisabled?: boolean
  disabled?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  useUiLanguageRevision()
  const setupId = useId()
  const preset = initialModel ? { model: initialModel, effort: initialEffort } : undefined
  const initial = preset
    ? applyAgentPickerEdit(entry, selected ?? source ?? agentPickerDraft(entry), {
        kind: 'choice',
        patch: {
          model: preset.model,
          ...(preset.effort ? { options: { effort: preset.effort } } : {})
        }
      })
    : undefined
  const closeMenu = useDropdownMenuClose()
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  return (
    <AgentLaunchSetupButton
      submenu
      draftScope={draftScope}
      draftId={draftId}
      preset={preset}
      entry={entry}
      initial={source}
      seed={initial ?? selected ?? source}
      surface={selected?.surface}
      mode={mode}
      open={openSetup === setupId}
      replacedByAnotherSetup={openSetup !== null && openSetup !== setupId}
      disabled={disabled || setupDisabled || !entry.surfaces.length}
      onOpenChange={(next) => {
        if (next || openSetup === setupId) {
          onSetupOpenChange(next ? { id: setupId, agent: entry.agent, preset, label } : null)
        }
        if (next && openSetup !== setupId) {
          onSelectAgent?.(entry.agent)
        }
      }}
      onUse={(draft) => {
        const chosen = mode === 'select' ? draft.surface : undefined
        const result =
          chosen === undefined
            ? runLaunch(pickerLaunchRow(entry, draft.surface), draft, entry)
            : runLaunch(pickerLaunchRow(entry, draft.surface), draft, entry, chosen)
        if (result !== false) {
          closeMenu()
        }
        return result
      }}
      renderAnchor={(trigger) => (
        <div
          data-agent-launch-row
          onClick={(event) => {
            event.preventDefault()
            if (disabled || !entry.surfaces.length) {
              return
            }
            const draft = initial ?? (mode === 'select' ? selected : undefined)
            const surface = draft?.surface ?? entry.defaultSurface
            const row = draft
              ? pickerLaunchRow(entry, surface)
              : (entry.rows.find((row) =>
                  surface === 'chat'
                    ? row.kind === 'chat'
                    : row.kind === 'terminal' || row.kind === 'cli'
                ) ?? pickerLaunchRow(entry, surface))
            const result = draft ? runLaunch(row, draft, entry) : runLaunch(row, undefined)
            if (result !== false) {
              closeMenu()
            }
          }}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              event.preventDefault()
              event.currentTarget.click()
            }
          }}
        >
          <Button asChild variant="menu-launch" size="menu">
            <span>
              <AgentIcon agent={entry.agent} size={14} />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
              {unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat') ? (
                <span className="text-xs text-muted-foreground">
                  {chatUnavailableLabel(unavailable.reason)}
                </span>
              ) : null}
            </span>
          </Button>
          {trigger}
        </div>
      )}
    />
  )
})
