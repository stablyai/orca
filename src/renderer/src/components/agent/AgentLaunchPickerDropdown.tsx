import { useState, type Ref } from 'react'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import { AgentVariantIcon } from '@/components/agent/icons/AgentVariantIcon'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { AgentDefaultContextMenu } from './agent-combobox-items'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type { AgentPickerChoice } from './agent-picker-search-rows'
import { useAgentPickerSetup } from './agent-launch-picker-drafts'
import { useRetiredAgentPickerDrafts } from './AgentLaunchPickerMenu'
import { chatUnavailableLabel } from './launch-menu/agent-menu-row-presentation'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit
} from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type { AgentPickerSetup } from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerDraftOwner,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

type Agent = AgentPickerEntry['agent']

export type AgentLaunchPickerDropdownPick = (
  agent: Agent,
  /** Absent when the user picked the agent itself, which keeps the form's own setup. */
  draft?: AgentPickerDraft,
  entry?: AgentPickerEntry,
  /** Set when the user named where the agent opens. */
  surface?: AgentPickerSurface
) => void

type AgentLaunchPickerDropdownProps = {
  entries: AgentPickerEntry[]
  /** The agent the form holds now. */
  agent: Agent | null
  value?: AgentPickerDraft
  draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
  draftScope: AgentPickerDraftOwner
  disabled?: boolean
  initialQuery?: string
  searchInputRef?: Ref<HTMLInputElement>
  defaultAgent?: Agent | 'blank' | null
  onSetDefault?: (agent: Agent) => void
  /** The agent whose pane is showing, so its catalog loads. */
  onPaneChange: (agent: Agent) => void
  onPick: AgentLaunchPickerDropdownPick
  onClose: () => void
  /** Rows under the card that are not agents. */
  choices?: readonly AgentPickerChoice[]
}

const focusSearch = (from: Element) =>
  from
    .closest('[data-agent-launch-picker]')
    ?.querySelector<HTMLInputElement>('[cmdk-input]')
    ?.focus({ preventScroll: true })

/** A form's agent dropdown: agent tabs over the shared setup card, then where the agent opens. */
export function AgentLaunchPickerDropdown(props: AgentLaunchPickerDropdownProps) {
  const { entries, agent, draftScope, onPaneChange } = props
  useRetiredAgentPickerDrafts(entries, draftScope, 'select')
  const [paneAgent, setPaneAgent] = useState(agent)
  // A typed-in query seeds only the first pane; switching agents starts a clean search.
  const [switched, setSwitched] = useState(false)
  const pane =
    entries.find((entry) => entry.agent === paneAgent) ??
    entries.find((entry) => entry.agent === agent) ??
    entries.find((entry) => entry.surfaces.length > 0) ??
    entries[0]
  if (!pane) {
    return null
  }
  return (
    <div
      className="flex flex-col"
      data-agent-launch-picker="true"
      onKeyDownCapture={(event) => {
        // Shift+Tab from the search goes back to the agent tabs.
        if (
          event.key === 'Tab' &&
          event.shiftKey &&
          event.target instanceof HTMLElement &&
          event.target.matches('[cmdk-input]')
        ) {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget
            .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
            ?.focus()
        }
      }}
    >
      <AgentPickerAgentTabs
        entries={entries}
        pane={pane.agent}
        defaultAgent={props.defaultAgent}
        onSetDefault={props.onSetDefault}
        onSelect={(next) => {
          setPaneAgent(next)
          setSwitched(true)
          onPaneChange(next)
        }}
      />
      {/* Why keyed: each agent's pane owns its own kept setup and search. */}
      <AgentLaunchPickerPane
        key={pane.agent}
        {...props}
        initialQuery={switched ? '' : props.initialQuery}
        entry={pane}
      />
    </div>
  )
}

function AgentPickerAgentTabs({
  entries,
  pane,
  defaultAgent,
  onSetDefault,
  onSelect
}: {
  entries: AgentPickerEntry[]
  pane: Agent
  defaultAgent?: Agent | 'blank' | null
  onSetDefault?: (agent: Agent) => void
  onSelect: (agent: Agent) => void
}) {
  const t = useTranslate()
  return (
    <div
      role="tablist"
      aria-label={t('agentPicker.agents', 'Agents')}
      className="flex shrink-0 items-center overflow-x-auto border-b border-border px-1.5 scrollbar-none"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          return
        }
        // The menu would read these keys as typeahead and item moves.
        event.stopPropagation()
        const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
        const index = event.target instanceof HTMLElement ? tabs.indexOf(event.target) : -1
        const move = (next: number) => {
          event.preventDefault()
          tabs[(next + tabs.length) % tabs.length]?.focus()
        }
        if (event.key === 'ArrowRight') {
          move(index + 1)
        } else if (event.key === 'ArrowLeft') {
          move(index - 1)
        } else if (event.key === 'Home') {
          move(0)
        } else if (event.key === 'End') {
          move(tabs.length - 1)
        } else if ((event.key === 'Tab' && !event.shiftKey) || event.key === 'ArrowDown') {
          event.preventDefault()
          focusSearch(event.currentTarget)
        }
      }}
    >
      {entries.map((entry) => {
        const missing = entry.surfaces.length === 0
        const selected = entry.agent === pane
        return (
          <AgentDefaultContextMenu
            key={entry.agent}
            isDefault={defaultAgent === entry.agent}
            onSetDefault={onSetDefault && !missing ? () => onSetDefault(entry.agent) : undefined}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  aria-selected={selected}
                  aria-label={entry.label}
                  // Why: a click keeps focus, and typing, in the search field.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(entry.agent)}
                  className={cn(
                    'grid h-9 w-[34px] shrink-0 place-items-center border-b-2 outline-none transition-[color,opacity] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                    selected
                      ? 'border-foreground text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                    missing && (selected ? 'opacity-60' : 'opacity-40 hover:opacity-70')
                  )}
                >
                  <AgentVariantIcon agent={entry.agent} size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {entry.label}
              </TooltipContent>
            </Tooltip>
          </AgentDefaultContextMenu>
        )
      })}
    </div>
  )
}

function AgentLaunchPickerPane({
  entry,
  entries,
  agent,
  value,
  draftForEntry,
  draftScope,
  disabled,
  initialQuery,
  searchInputRef,
  choices,
  onPick,
  onClose
}: AgentLaunchPickerDropdownProps & { entry: AgentPickerEntry }) {
  const selected = value?.agent === entry.agent ? value : undefined
  const source = draftForEntry?.(entry)
  const setup = useAgentPickerSetup({
    entry,
    // Without a form source, the form's own value is what a kept setup must still derive from.
    initial: source ?? selected,
    seed: selected ?? source,
    surface: selected?.surface,
    draftScope,
    mode: 'select',
    open: true
  })
  const current = agent === entry.agent
  /** Takes the pane's setup into the form; `surface` when the user named where it opens. */
  const commit = (close: boolean, surface?: AgentPickerSurface) => {
    const draft = setup.getDraft()
    if (!draft) {
      return
    }
    const accepted = acceptAgentPickerArguments(entry, draft)
    const picked = surface ? { ...accepted, surface } : accepted
    if (!setup.accept(picked, !close)) {
      return
    }
    onPick(entry.agent, picked, entry, surface)
    if (close) {
      onClose()
    }
  }
  const pickSearchResult = (result: AgentPickerSetup) => {
    const edit = { kind: 'choice' as const, patch: result.choices }
    if (result.entry.agent === entry.agent) {
      const draft = setup.getDraft()
      if (draft) {
        setup.change(applyAgentPickerEdit(entry, draft, edit))
        commit(true)
      }
      return
    }
    const other = result.entry
    const base =
      (value?.agent === other.agent ? value : undefined) ??
      draftForEntry?.(other) ??
      agentPickerDraft(other)
    onPick(other.agent, applyAgentPickerEdit(other, base, edit), other)
    onClose()
  }
  // As the agent rows did: the form's setup for the agent in use, else only the agent and how it opens.
  const pickAgent = (picked: AgentPickerEntry) => {
    const held = value?.agent === picked.agent ? value : undefined
    if (held) {
      onPick(picked.agent, held, picked)
    } else {
      const row = picked.rows.find((candidate) =>
        picked.defaultSurface === 'chat'
          ? candidate.kind === 'chat'
          : candidate.kind === 'terminal' || candidate.kind === 'cli'
      )
      onPick(
        picked.agent,
        undefined,
        undefined,
        picked.agent !== agent && row?.kind === 'chat' ? 'chat' : undefined
      )
    }
    onClose()
  }
  if (!setup.ready) {
    return null
  }
  const currentModel = value?.agent === agent ? value?.choices.model : undefined
  return (
    <AgentLaunchSetupPanel
      entry={entry}
      mode="select"
      draft={setup.draft}
      getDraft={setup.getDraft}
      disabled={disabled}
      autoFocus={false}
      initialQuery={initialQuery}
      searchInputRef={searchInputRef}
      search={{
        entries,
        current: agent ? { agent, model: currentModel } : undefined,
        onPick: pickSearchResult,
        onPickAgent: pickAgent,
        choices
      }}
      onDraftChange={(draft, edit) => {
        setup.change(draft)
        // Effort and speed apply at once to the agent in use; another agent's wait for its pick.
        if (current && (edit === 'choice' || edit === 'speed')) {
          commit(false)
        }
      }}
      onPickModel={(draft) => {
        setup.change(draft)
        commit(true)
      }}
      onUse={(draft) => commit(true, draft.surface)}
    >
      {entry.textGeneration ? null : (
        <AgentLaunchOpenIn
          entry={entry}
          surface={setup.draft.surface}
          disabled={disabled}
          onChoose={(surface) => commit(true, surface)}
        />
      )}
    </AgentLaunchSetupPanel>
  )
}

/** Chat or CLI, a setting of the pick rather than a launch: a track with the chosen side raised. */
function AgentLaunchOpenIn({
  entry,
  surface,
  disabled,
  onChoose
}: {
  entry: AgentPickerEntry
  surface: AgentPickerSurface
  disabled?: boolean
  onChoose: (surface: AgentPickerSurface) => void
}) {
  const t = useTranslate()
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  const chatReason = entry.surfaces.includes('chat')
    ? undefined
    : unavailable?.kind === 'chat-unavailable'
      ? chatUnavailableLabel(unavailable.reason, t)
      : t('agentPicker.noChat', 'No chat for {{agent}}', { agent: entry.label })
  const label = t('agentPicker.openIn', 'Open as')
  const chat = (
    <ToggleGroupItem value="chat" disabled={Boolean(chatReason)} className="h-6">
      <MessageSquare className="size-3.5" />
      {t('agentPicker.chat', 'Chat')}
    </ToggleGroupItem>
  )
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border pr-2 pl-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ToggleGroup
        type="single"
        variant="segmented-card"
        size="xs"
        spacing={0.5}
        role="radiogroup"
        aria-label={label}
        disabled={disabled}
        value={surface}
        // Radix reports a press on the chosen side as empty; it still picks.
        onValueChange={(next) => onChoose(next === 'chat' || next === 'terminal' ? next : surface)}
        className="flex w-auto"
      >
        {chatReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">{chat}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {chatReason}
            </TooltipContent>
          </Tooltip>
        ) : (
          chat
        )}
        <ToggleGroupItem
          value="terminal"
          disabled={!entry.surfaces.includes('terminal')}
          className="h-6"
        >
          <SquareTerminal className="size-3.5" />
          {t('agentPicker.cli', 'CLI')}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
