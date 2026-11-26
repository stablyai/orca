import { useRef, useState, type Ref } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { AgentLaunchSurfaceButtons } from './AgentLaunchSetupFooter'
import { AgentPickerAgentTabs, AgentPickerBlankTerminalPane } from './AgentPickerAgentRail'
import { AgentPickerChoiceRows, type AgentPickerChoice } from './agent-picker-search-rows'
import { useAgentPickerSetup } from './agent-launch-picker-drafts'
import { useRetiredAgentPickerDrafts } from './AgentLaunchPickerMenu'
import { chatUnavailableLabel, entrySetupLabel } from './launch-menu/agent-menu-row-presentation'
import {
  acceptAgentPickerArguments,
  applyAgentPickerEdit
} from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type { AgentPickerSetup } from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import {
  agentPickerButtonOrder,
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
  surface?: AgentPickerSurface,
  /** The user chose the draft's permission in this pane, even one it already showed. */
  permissionPicked?: boolean
) => void

type AgentLaunchPickerDropdownProps = {
  entries: AgentPickerEntry[]
  /** The agent the form holds now. */
  agent: Agent | null
  value?: AgentPickerDraft
  draftForEntry?: (entry: AgentPickerEntry) => AgentPickerDraft
  draftScope: AgentPickerDraftOwner
  disabled?: boolean
  selectAgentOnTab?: boolean
  initialQuery?: string
  searchInputRef?: Ref<HTMLInputElement>
  defaultAgent?: Agent | 'blank' | null
  onSetDefault?: (agent: Agent) => void
  /** The agent whose pane is showing, so its catalog loads. */
  onPaneChange: (agent: Agent) => void
  onPick: AgentLaunchPickerDropdownPick
  onClose: () => void
  /** Rows under the card that are not agents; `leading` ones go over the agent tabs instead. */
  choices?: readonly AgentPickerChoice[]
  /** A tile ahead of the agent tabs, also listed by search; current when the form holds no agent. */
  blankTerminal?: AgentPickerChoice
}

/** A form's agent dropdown: agent tabs over the shared setup card, then where the agent opens. */
export function AgentLaunchPickerDropdown(props: AgentLaunchPickerDropdownProps) {
  const t = useTranslate()
  const { entries, agent, draftScope, onPaneChange, blankTerminal } = props
  const leadingChoices = props.choices?.filter((choice) => choice.leading)
  const underChoices = props.choices?.filter((choice) => !choice.leading)
  const leadingRows = useRef<HTMLDivElement>(null)
  useRetiredAgentPickerDrafts(entries, draftScope, 'select')
  const [paneAgent, setPaneAgent] = useState(agent)
  // A typed-in query opens on an agent's search instead.
  const [terminalPane, setTerminalPane] = useState(
    () => Boolean(blankTerminal) && agent === null && !props.initialQuery
  )
  // A typed-in query seeds only the first pane; switching agents starts a clean search.
  const [switched, setSwitched] = useState(false)
  const pane =
    entries.find((entry) => entry.agent === paneAgent) ??
    entries.find((entry) => entry.agent === agent) ??
    entries.find((entry) => entry.surfaces.length > 0) ??
    entries[0]
  const showPane = (next: Agent) => {
    setPaneAgent(next)
    setSwitched(true)
    onPaneChange(next)
  }
  if (!pane) {
    if (!props.selectAgentOnTab) {
      return null
    }
    return props.choices?.length ? (
      props.choices.map((choice) => (
        <DropdownMenuItem key={choice.id} onSelect={choice.onSelect}>
          {choice.icon}
          {choice.label}
        </DropdownMenuItem>
      ))
    ) : (
      <DropdownMenuItem disabled>
        {t('auto.components.tab.bar.QuickLaunchButton.e518f544b1', 'No agents detected')}
      </DropdownMenuItem>
    )
  }
  return (
    <div
      className="flex min-h-0 flex-col"
      data-agent-launch-picker="true"
      onKeyDownCapture={(event) => {
        // Shift+Tab from the search goes back to the agent tabs.
        if (
          event.key === 'Tab' &&
          event.shiftKey &&
          event.target instanceof HTMLElement &&
          event.target.matches('[cmdk-input], [data-agent-picker-blank-terminal]')
        ) {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget
            .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
            ?.focus()
        }
      }}
    >
      {leadingChoices?.length ? (
        <AgentPickerChoiceRows
          ref={leadingRows}
          top
          choices={leadingChoices}
          disabled={props.disabled}
          onLeaveDown={() =>
            leadingRows.current?.parentElement
              ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
              ?.focus()
          }
        />
      ) : null}
      <AgentPickerAgentTabs
        entries={entries}
        onLeaveUp={
          leadingChoices?.length
            ? () =>
                [
                  ...(leadingRows.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ??
                    [])
                ]
                  .at(-1)
                  ?.focus()
            : undefined
        }
        pane={terminalPane ? null : pane.agent}
        blankTerminal={blankTerminal}
        defaultAgent={props.defaultAgent}
        onSetDefault={props.onSetDefault}
        onSelect={(next) => {
          setTerminalPane(false)
          showPane(next)
          if (props.selectAgentOnTab && next !== agent) {
            props.onPick(next)
          }
        }}
      />
      {terminalPane && blankTerminal ? (
        <AgentPickerBlankTerminalPane
          label={blankTerminal.label}
          disabled={props.disabled}
          onClose={props.onClose}
        />
      ) : (
        // Why keyed: each agent's pane owns its own kept setup and search.
        <AgentLaunchPickerPane
          key={pane.agent}
          {...props}
          choices={underChoices}
          leadingChoices={leadingChoices}
          initialQuery={switched ? '' : props.initialQuery}
          entry={pane}
          onShowAgent={showPane}
        />
      )}
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
  selectAgentOnTab,
  initialQuery,
  searchInputRef,
  choices,
  leadingChoices,
  blankTerminal,
  onPick,
  onClose,
  onShowAgent
}: AgentLaunchPickerDropdownProps & {
  leadingChoices?: readonly AgentPickerChoice[]
  entry: AgentPickerEntry
  /** Shows another agent's pane, for a search pick that keeps the dropdown open. */
  onShowAgent: (agent: Agent) => void
}) {
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
  // Why: a form that keeps a permission apart from the agent must tell a chosen one from one only shown.
  const permissionPicked = useRef(false)
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
    onPick(entry.agent, picked, entry, surface, permissionPicked.current)
    if (close) {
      onClose()
    }
  }
  /** A model pick applies at once; `close` (Enter) also opens it the default way, as the filled button does. */
  const pickModel = (draft: AgentPickerDraft, close: boolean) => {
    setup.change(draft)
    commit(close, close ? entry.defaultSurface : undefined)
  }
  const pickSearchResult = (result: AgentPickerSetup, close: boolean) => {
    const edit = { kind: 'choice' as const, patch: result.choices }
    if (result.entry.agent === entry.agent) {
      const draft = setup.getDraft()
      if (draft) {
        pickModel(applyAgentPickerEdit(entry, draft, edit), close)
      }
      return
    }
    const other = result.entry
    const base =
      (value?.agent === other.agent ? value : undefined) ??
      draftForEntry?.(other) ??
      agentPickerDraft(other)
    const edited = applyAgentPickerEdit(other, base, edit)
    if (close) {
      onPick(other.agent, { ...edited, surface: other.defaultSurface }, other, other.defaultSurface)
      onClose()
    } else {
      onPick(other.agent, edited, other)
      onShowAgent(other.agent)
    }
  }
  // As the agent rows did: the form's setup for the agent in use, else only the agent and how it opens.
  const pickAgent = (picked: AgentPickerEntry, close: boolean) => {
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
    if (close) {
      onClose()
    } else {
      onShowAgent(picked.agent)
    }
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
        choices,
        searchChoices: [...(leadingChoices ?? []), ...(blankTerminal ? [blankTerminal] : [])]
      }}
      onDraftChange={(draft, edit) => {
        // Same as chats clears the permission through a choice edit, so a changed one counts too.
        if (
          edit === 'permission' ||
          setup.getDraft()?.choices.permissionMode !== draft.choices.permissionMode
        ) {
          permissionPicked.current = true
        }
        setup.change(draft)
        // Effort, speed and a kept permission apply at once to the agent in use; another agent's wait.
        if (current && (edit === 'choice' || edit === 'speed' || edit === 'permission')) {
          commit(false)
        }
      }}
      onPickModel={pickModel}
      onUse={(draft) => commit(true, draft.surface)}
    >
      {selectAgentOnTab || entry.textGeneration ? null : (
        <AgentLaunchOpenAs
          entry={entry}
          disabled={disabled}
          onChoose={(surface) => commit(true, surface)}
        />
      )}
    </AgentLaunchSetupPanel>
  )
}

/** Open as chat or terminal: each takes the pane's setup and closes, like the launch buttons. */
function AgentLaunchOpenAs({
  entry,
  disabled,
  onChoose
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  onChoose: (surface: AgentPickerSurface) => void
}) {
  const t = useTranslate()
  const order = agentPickerButtonOrder(entry)
  if (!order.length) {
    return null
  }
  const unavailable = entry.rows.find((row) => row.kind === 'chat-unavailable')
  // Why this place refuses a chat the agent has; a disabled button can't show it on hover.
  const chatRefused =
    !entry.surfaces.includes('chat') && unavailable?.kind === 'chat-unavailable'
      ? chatUnavailableLabel(unavailable.reason, t)
      : undefined
  const reasons: Partial<Record<AgentPickerSurface, string>> = {
    chat: entry.surfaces.includes('chat')
      ? undefined
      : (chatRefused ?? t('agentPicker.noChat', 'No chat for {{agent}}', { agent: entry.label })),
    terminal: entry.surfaces.includes('terminal')
      ? undefined
      : t('agentPicker.noTerminal', 'No terminal for {{agent}}', { agent: entry.label })
  }
  // A surface the agent lacks stays as a disabled button that says why.
  const missing = (['chat', 'terminal'] as const).filter((surface) => !order.includes(surface))
  return (
    <div className="flex flex-col gap-1.5 border-t border-border px-2 py-2">
      <div className="flex items-center">
        <AgentLaunchSurfaceButtons
          entry={entry}
          surfaces={[...missing, ...order]}
          verb="open"
          disabled={disabled}
          unavailable={reasons}
          primary={entry.defaultSurface}
          onSelect={onChoose}
        />
        {entrySetupLabel(entry, t) ? (
          <span className="ml-auto text-xs text-muted-foreground">{entrySetupLabel(entry, t)}</span>
        ) : null}
      </div>
      {chatRefused ? <p className="text-xs text-muted-foreground">{chatRefused}</p> : null}
    </div>
  )
}
