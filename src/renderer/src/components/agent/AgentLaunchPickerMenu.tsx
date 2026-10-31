import { selectWorktreesByRepo, selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useAppStore } from '@/store'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { Input } from '@/components/ui/input'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  AgentLaunchSetupButton,
  retireAgentPickerDrafts,
  type AgentPickerSetupIdentity
} from './AgentLaunchSetupButton'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch-picker-edits'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import {
  searchAgentPickerSetups,
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

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

type Launch = (row: NewTabAgentMenuRow, draft?: AgentPickerDraft, entry?: AgentPickerEntry) => void

function keepSetupFocus(event: PointerEvent<HTMLDivElement>) {
  // Radix row hover must not steal focus from the row's portaled setup or its nested controls.
  if (event.currentTarget.querySelector('[data-slot="popover-trigger"][aria-expanded="true"]')) {
    event.preventDefault()
  }
}

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
    retireAgentPickerDrafts(entries, draftScope, (target) => {
      const host = parseExecutionHostId(target.executionHostId)
      return (
        !(
          host?.kind === 'runtime' && state.removedRuntimeEnvironmentIds?.has(host.environmentId)
        ) &&
        (!target.worktreeId || workspaces.has(target.worktreeId)) &&
        (!target.repoId || repos.has(target.repoId))
      )
    })
  }, [entries, draftScope])
  const [query, setQuery] = useState('')
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
        <div className="p-1">
          <Input
            value={query}
            density="compact"
            autoFocus
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
      {setups.map((setup) => {
        const source = draftForEntry?.(setup.entry)
        return (
          <AgentPickerMenuRow
            key={`${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
            draftScope={draftScope}
            draftId={`${setup.model.id}:${setup.choices.options?.effort ?? ''}`}
            preset={{ model: setup.model.id, effort: setup.choices.options?.effort }}
            entry={setup.entry}
            mode={mode}
            setupDisabled={setupDisabled}
            openSetup={openSetup}
            onSetupOpenChange={setActiveSetup}
            label={setup.label}
            source={source}
            selected={value?.agent === setup.entry.agent ? value : undefined}
            initial={applyAgentPickerEdit(
              setup.entry,
              (value?.agent === setup.entry.agent ? value : source) ??
                agentPickerDraft(setup.entry),
              { kind: 'choice', patch: setup.choices }
            )}
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
      {!visible.length && !setups.length ? (
        <DropdownMenuItem disabled>
          {translate(
            'auto.components.agent.AgentCombobox.579c768bde',
            'No agents match your search.'
          )}
        </DropdownMenuItem>
      ) : null}
    </div>
  )
}

function AgentPickerMenuRow({
  entry,
  draftScope,
  draftId,
  preset,
  openSetup,
  onSetupOpenChange,
  label = entry.label,
  initial,
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
  preset?: AgentPickerSetupIdentity
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
  initial?: AgentPickerDraft
  source?: AgentPickerDraft
  selected?: AgentPickerDraft
  mode?: 'launch' | 'select'
  setupDisabled?: boolean
  disabled?: boolean
  runLaunch: Launch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
}) {
  const setupId = JSON.stringify([entry.agent, draftId])
  const item = useRef<HTMLDivElement>(null)
  const configured = useRef<AgentPickerDraft | undefined>(undefined)
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  return (
    <AgentLaunchSetupButton
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
      disabled={disabled || setupDisabled}
      onOpenChange={(next) => {
        onSetupOpenChange(next ? { id: setupId, agent: entry.agent, preset, label } : null)
        if (next) {
          onSelectAgent?.(entry.agent)
        }
      }}
      onUse={(draft) => {
        configured.current = draft
        item.current?.click()
      }}
      renderAnchor={(trigger) => (
        <DropdownMenuItem
          ref={item}
          variant="launch"
          disabled={disabled || !entry.surfaces.length}
          onSelect={() => {
            const draft = configured.current ?? initial
            configured.current = undefined
            const surface = draft?.surface ?? entry.defaultSurface
            const row = draft
              ? pickerLaunchRow(entry, surface)
              : (entry.rows.find((row) =>
                  surface === 'chat'
                    ? row.kind === 'chat'
                    : row.kind === 'terminal' || row.kind === 'cli'
                ) ?? pickerLaunchRow(entry, surface))
            if (draft) {
              runLaunch(row, draft, entry)
            } else {
              runLaunch(row, undefined)
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              item.current?.querySelector<HTMLButtonElement>('button')?.focus()
            }
          }}
          onPointerMove={keepSetupFocus}
          onPointerLeave={keepSetupFocus}
        >
          <AgentIcon agent={entry.agent} size={14} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
          {unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat') ? (
            <span className="text-xs text-muted-foreground">
              {chatUnavailableLabel(unavailable.reason)}
            </span>
          ) : null}
          {trigger}
        </DropdownMenuItem>
      )}
    />
  )
}
