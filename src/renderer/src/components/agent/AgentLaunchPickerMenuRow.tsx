import { terminalPendingLabel } from '../tab-bar/new-tab-agent-menu-model'
import { memo, useId } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  useDropdownMenuClose
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { AgentDefaultContextMenu } from './agent-combobox-items'
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
import { useTranslate } from '@/i18n/use-translate'

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
  terminalBlocked,
  runLaunch,
  shortcut,
  onSelectAgent,
  isDefault = false,
  onSetDefault
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
  terminalBlocked?: boolean
  runLaunch: AgentPickerMenuLaunch
  shortcut?: string
  onSelectAgent?: (agent: AgentPickerEntry['agent']) => void
  isDefault?: boolean
  /** Base agent rows only; setup rows are presets, not default-agent choices. */
  onSetDefault?: (agent: AgentPickerEntry['agent']) => void
}) {
  const t = useTranslate()
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
  const surface =
    initial?.surface ?? (mode === 'select' ? selected?.surface : undefined) ?? entry.defaultSurface
  const launchBlocked = mode !== 'select' && terminalBlocked && surface === 'terminal'
  const reasonId = useId()
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  const setDefault =
    onSetDefault && entry.surfaces.length ? () => onSetDefault(entry.agent) : undefined
  if (setupDisabled) {
    return (
      <AgentDefaultContextMenu isDefault={isDefault} onSetDefault={setDefault}>
        <DropdownMenuItem
          className="min-h-9"
          disabled={disabled || launchBlocked || !entry.surfaces.length}
          data-search-default={searchDefault || undefined}
          aria-description={launchBlocked ? terminalPendingLabel(t) : undefined}
          onSelect={(event) => {
            onSelectAgent?.(entry.agent)
            if (
              runLaunch(pickerLaunchRow(entry, selected?.surface ?? entry.defaultSurface)) === false
            ) {
              event.preventDefault()
            }
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
      </AgentDefaultContextMenu>
    )
  }
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
      terminalBlocked={terminalBlocked}
      open={openSetup === setupId}
      disabled={disabled || setupDisabled || !entry.surfaces.length}
      onOpenChange={(next) => {
        if (next || openSetup === setupId) {
          onSetupOpenChange(next ? { id: setupId, agent: entry.agent, preset, label } : null)
        }
        if (next && openSetup !== setupId) {
          onSelectAgent?.(entry.agent)
        }
      }}
      onSelect={
        mode === 'select'
          ? (draft) => runLaunch(pickerLaunchRow(entry, draft.surface), draft, entry)
          : undefined
      }
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
          data-search-default={searchDefault || undefined}
          onClick={(event) => {
            event.preventDefault()
            if (disabled || launchBlocked || !entry.surfaces.length) {
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
          {/* Why: the anchor is a Radix sub-trigger's asChild child, so the context menu wraps the label instead. */}
          <AgentDefaultContextMenu isDefault={isDefault} onSetDefault={setDefault}>
            <Button
              type="button"
              variant="menu-launch"
              size="menu-launch"
              aria-disabled={launchBlocked || undefined}
              aria-describedby={launchBlocked ? reasonId : undefined}
            >
              <AgentIcon agent={entry.agent} size={14} />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              {shortcut ? <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut> : null}
              {launchBlocked ? (
                <span
                  id={reasonId}
                  className="min-w-0 shrink truncate text-xs text-muted-foreground"
                >
                  {terminalPendingLabel()}
                </span>
              ) : unavailable?.kind === 'chat-unavailable' && !entry.surfaces.includes('chat') ? (
                <span className="text-xs text-muted-foreground">
                  {chatUnavailableLabel(unavailable.reason)}
                </span>
              ) : null}
            </Button>
          </AgentDefaultContextMenu>
          {trigger}
        </div>
      )}
    />
  )
})
