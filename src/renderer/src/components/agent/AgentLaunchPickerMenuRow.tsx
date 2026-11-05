import { memo, useId } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentLaunchSetupButton, type AgentPickerSetupIdentity } from './AgentLaunchSetupButton'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import { chatUnavailableLabel } from '../tab-bar/tab-agent-row-presentation'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

function pickerLaunchRow(entry: AgentPickerEntry, surface: AgentPickerSurface): NewTabAgentMenuRow {
  return {
    agent: entry.agent,
    kind: surface === 'chat' ? 'chat' : 'cli',
    executionHostId: entry.rows[0]?.executionHostId
  }
}

export type AgentPickerMenuLaunch = (
  row: NewTabAgentMenuRow,
  draft?: AgentPickerDraft,
  entry?: AgentPickerEntry,
  /** Select mode: the surface explicitly accepted by a named launch action. */
  surface?: AgentPickerSurface
) => boolean | void | Promise<boolean>

// Why: catalog and seed reads land one agent at a time after the menu opens; only that row re-renders.
export const AgentPickerMenuRow = memo(function AgentPickerMenuRow({
  entry,
  draftScope,
  draftId,
  initialModel,
  initialEffort,
  openSetup,
  onSetupOpenChange,
  label = entry.label,
  searchDefault,
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
  /** The row Enter in the search field would pick. */
  searchDefault?: boolean
  source?: AgentPickerDraft
  selected?: AgentPickerDraft
  mode?: 'launch' | 'select'
  setupDisabled?: boolean
  disabled?: boolean
  runLaunch: AgentPickerMenuLaunch
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
  if (setupDisabled) {
    return (
      <DropdownMenuItem
        disabled={disabled || !entry.surfaces.length}
        className={searchDefault ? 'bg-black/8 text-accent-foreground dark:bg-white/14' : undefined}
        onSelect={() => {
          onSelectAgent?.(entry.agent)
          runLaunch(pickerLaunchRow(entry, selected?.surface ?? entry.defaultSurface))
        }}
      >
        <AgentIcon agent={entry.agent} size={14} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{label}</span>
          {entry.description ? (
            <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
          ) : null}
        </span>
        {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
      </DropdownMenuItem>
    )
  }
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
          className={searchDefault ? 'bg-accent text-accent-foreground' : undefined}
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
