import { useState, type ReactElement } from 'react'
import { AgentLaunchSetupSubmenu } from './AgentLaunchSetupSubmenu'
import { useTranslate } from '@/i18n/use-translate'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import { DoubaoSessionResume } from './DoubaoSessionResume'
import { useDropdownMenuClose } from '@/components/ui/dropdown-menu'
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

export function AgentLaunchSetupButton({
  entry,
  draftScope,
  draftId = 'agent',
  preset,
  initial,
  seed,
  renderAnchor,
  disabled,
  terminalBlocked,
  allowSessionResume,
  open: controlledOpen,
  onOpenChange,
  returnFocus,
  onUse
}: {
  entry: AgentPickerEntry
  draftScope?: AgentPickerDraftOwner
  draftId?: string
  preset?: AgentPickerSetupIdentity
  initial?: AgentPickerDraft
  seed?: AgentPickerDraft
  renderAnchor: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  terminalBlocked?: boolean
  allowSessionResume?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  returnFocus?: () => void
  onUse: (draft: AgentPickerDraft) => boolean | void | Promise<boolean>
}) {
  const t = useTranslate()
  const closeMenu = useDropdownMenuClose()
  const [localOpen, setOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setup = useAgentPickerSetup({
    entry,
    initial,
    seed,
    draftScope,
    draftId,
    preset,
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
          draft={setup.draft}
          getDraft={setup.getDraft}
          disabled={disabled}
          autoFocus={autoFocus}
          terminalBlocked={terminalBlocked}
          onDraftChange={setup.change}
          onUse={(draft) => {
            if (terminalBlocked && draft.surface === 'terminal') {
              return false
            }
            const options = { ...draft, surface: setup.draft.surface }
            delete options.prompt
            if (!setup.accept(options)) {
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
      {setup.ready && allowSessionResume && entry.agent === 'doubao' && entry.worktreeId ? (
        <DoubaoSessionResume
          worktreeId={entry.worktreeId}
          executionHostId={entry.rows[0]?.executionHostId}
          disabled={disabled || terminalBlocked}
          onResumed={() => {
            changeOpen(false)
            closeMenu()
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
