import { useState, type ReactElement } from 'react'
import { AgentLaunchSetupSubmenu } from './AgentLaunchSetupSubmenu'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
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
  onDraftChange: (draft: AgentPickerDraft) => void
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
  open: controlledOpen,
  onOpenChange,
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
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onUse: (draft: AgentPickerDraft) => boolean | void | Promise<boolean>
}) {
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
  const panel = (
    <div className="min-h-0 overflow-y-auto scrollbar-sleek">
      {setup.ready ? (
        <AgentLaunchSetupPanel
          entry={entry}
          mode={mode}
          draft={setup.draft}
          getDraft={setup.getDraft}
          disabled={disabled}
          onDraftChange={setup.change}
          onUse={(draft) => {
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
      label={translate('agentPicker.configure', 'Configure {{agent}}', { agent: entry.label })}
    >
      {panel}
    </AgentLaunchSetupSubmenu>
  )
}
