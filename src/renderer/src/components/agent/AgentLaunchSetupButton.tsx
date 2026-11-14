import { useState, type ReactElement } from 'react'
import { AgentLaunchSetupSubmenu } from './AgentLaunchSetupSubmenu'
import { useTranslate } from '@/i18n/use-translate'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import {
  acceptAgentPickerArguments,
  type AgentPickerEdit
} from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import type {
  AgentPickerDraft,
  AgentPickerEntry,
  AgentPickerDraftOwner
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

import { useAgentPickerSetup, type AgentPickerSetupIdentity } from './agent-launch-picker-drafts'

export {
  invalidateAgentPickerDrafts,
  retireAgentPickerDrafts,
  useAgentPickerDraftScope
} from './agent-launch-picker-drafts'
export type { AgentPickerSetupIdentity } from './agent-launch-picker-drafts'

export type AgentLaunchSetupPanelProps = {
  entry: AgentPickerEntry
  draft: AgentPickerDraft
  getDraft: () => AgentPickerDraft | undefined
  mode?: 'launch' | 'select'
  disabled?: boolean
  autoFocus?: boolean
  terminalBlocked?: boolean
  onDraftChange: (draft: AgentPickerDraft, edit: AgentPickerEdit['kind']) => void
  onUse: (draft: AgentPickerDraft) => boolean | void | Promise<boolean>
}

export function AgentLaunchSetupButton({
  entry,
  draftScope,
  draftId = 'agent',
  preset,
  initial,
  seed,
  surface,
  mode = 'launch',
  renderAnchor,
  disabled,
  terminalBlocked,
  open: controlledOpen,
  onOpenChange,
  returnFocus,
  onSelect,
  onUse
}: {
  entry: AgentPickerEntry
  draftScope?: AgentPickerDraftOwner
  draftId?: string
  preset?: AgentPickerSetupIdentity
  initial?: AgentPickerDraft
  seed?: AgentPickerDraft
  surface?: AgentPickerDraft['surface']
  mode?: 'launch' | 'select'
  renderAnchor: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  terminalBlocked?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  returnFocus?: () => void
  /** Select mode: a pick in the panel applies to the form without closing the menu. */
  onSelect?: (draft: AgentPickerDraft) => void
  onUse: (draft: AgentPickerDraft) => boolean | void | Promise<boolean>
}) {
  const t = useTranslate()
  const [localOpen, setOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setup = useAgentPickerSetup({
    entry,
    initial,
    seed,
    surface,
    draftScope,
    draftId,
    preset,
    mode,
    open
  })
  const changeOpen = (next: boolean) => {
    if (next) {
      setup.activate()
    }
    if (controlledOpen === undefined) {
      setOpen(next)
    }
    onOpenChange?.(next)
  }
  const panel = (autoFocus: boolean) => (
    <div className="min-h-0 overflow-y-auto scrollbar-sleek">
      {setup.ready ? (
        <AgentLaunchSetupPanel
          entry={entry}
          mode={mode}
          draft={setup.draft}
          getDraft={setup.getDraft}
          disabled={disabled}
          autoFocus={autoFocus}
          terminalBlocked={terminalBlocked}
          onDraftChange={(draft, edit) => {
            setup.change(draft)
            // Why: a launch form's trigger and Create read its selection, so a pick applies without closing the panel.
            // Arguments edits and text cards stay staged until Launch or Use.
            const picked = edit === 'choice' || edit === 'permission' || edit === 'speed'
            const current =
              picked && mode === 'select' && !entry.textGeneration ? setup.getDraft() : undefined
            const selected = current && acceptAgentPickerArguments(entry, current)
            if (selected && setup.accept(selected, true)) {
              onSelect?.(selected)
            }
          }}
          onUse={(draft) => {
            if (mode !== 'select' && terminalBlocked && draft.surface === 'terminal') {
              return false
            }
            const options = { ...draft, surface: setup.draft.surface }
            delete options.prompt
            if (!setup.accept(mode === 'select' ? draft : options)) {
              return false
            }
            const accepted = onUse(draft)
            if (accepted !== false) {
              changeOpen(false)
            }
            return accepted
          }}
        />
      ) : null}
    </div>
  )
  return (
    <AgentLaunchSetupSubmenu
      open={open}
      onOpenChange={changeOpen}
      renderAnchor={renderAnchor}
      disabled={disabled}
      label={t('agentPicker.configure', 'Configure {{agent}}', { agent: entry.label })}
      returnFocus={returnFocus}
    >
      {panel}
    </AgentLaunchSetupSubmenu>
  )
}
