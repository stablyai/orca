import { Terminal } from 'lucide-react'
import type { AgentPermissionChoice } from '../../../../shared/tui-agent-permission-choice'
import { translate } from '@/i18n/i18n'
import { DropdownMenuRadioItem, DropdownMenuSeparator } from '../ui/dropdown-menu'
import {
  NativeChatPermissionModeItems,
  NativeChatPermissionModeName
} from '../native-chat/NativeChatPermissionModePicker'

function ownDescription(chatOwnSupported: boolean): string {
  if (!chatOwnSupported) {
    return translate(
      'settings.agents.permissionOwnLegacyDescription',
      'Orca adds no permission flag in terminals; chats use Settings → Chat.'
    )
  }
  return translate(
    'settings.agents.permissionOwnDescription',
    'Terminals and chats follow the agent’s own permission settings.'
  )
}

/** A choice's name as the chat picker shows it; own gets a terminal icon. */
export function AgentPermissionChoiceName({
  choice,
  ownLabel,
  truncate
}: {
  choice: AgentPermissionChoice
  ownLabel: string
  truncate?: boolean
}): React.JSX.Element {
  if (choice !== 'own') {
    return <NativeChatPermissionModeName mode={choice} truncate={truncate} />
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Terminal className="size-3.5 shrink-0" aria-hidden />
      {truncate ? <span className="truncate">{ownLabel}</span> : <span>{ownLabel}</span>}
    </span>
  )
}

/** The chat picker's items, with the agent's own settings after a separator. */
export function AgentPermissionChoiceItems({
  choices,
  agent,
  ownLabel,
  chatOwnSupported,
  disabled,
  onSelect
}: {
  choices: readonly AgentPermissionChoice[]
  agent?: string
  ownLabel: string
  chatOwnSupported: boolean
  disabled?: boolean
  onSelect: (choice: AgentPermissionChoice) => void
}): React.JSX.Element {
  const modes = choices.filter((choice) => choice !== 'own')
  return (
    <>
      <NativeChatPermissionModeItems
        modes={modes}
        agent={agent}
        disabled={disabled}
        onSelect={onSelect}
      />
      {choices.includes('own') ? (
        <>
          {modes.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuRadioItem value="own" disabled={disabled} onSelect={() => onSelect('own')}>
            <div className="min-w-0 py-0.5">
              <AgentPermissionChoiceName choice="own" ownLabel={ownLabel} />
              <div className="text-xs font-normal text-muted-foreground">
                {ownDescription(chatOwnSupported)}
              </div>
            </div>
          </DropdownMenuRadioItem>
        </>
      ) : null}
    </>
  )
}
