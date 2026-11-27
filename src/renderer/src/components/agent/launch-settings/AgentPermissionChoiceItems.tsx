// @protected-copy scope=file
// What a permission choice does: a language pack must never misstate it.
import { Terminal } from 'lucide-react'
import type { AgentPermissionChoice } from '../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { DropdownMenuSeparator } from '../../ui/dropdown-menu'
import {
  NativeChatPermissionModeItems,
  NativeChatPermissionModeName
} from '../../native-chat/session/options/controls/NativeChatPermissionModePicker'
import { PermissionChoiceRadioItem } from '../../native-chat/session/options/controls/PermissionChoiceRadioItem'

function ownDescription(chatOwnSupported: boolean, t: Translate = translate): string {
  if (!chatOwnSupported) {
    return t(
      'settings.agents.permissionOwnLegacyDescription',
      'Orca adds no permission flag in terminals; chats use Settings → Chat.'
    )
  }
  return t(
    'settings.agents.permissionOwnDescription',
    'Terminals and chats follow the agent’s own permission settings.'
  )
}

/** A choice's name as the chat picker shows it; own gets a terminal icon. */
export function AgentPermissionChoiceName({
  choice,
  agent,
  ownLabel,
  truncate
}: {
  choice: AgentPermissionChoice
  agent?: string
  ownLabel: string
  truncate?: boolean
}): React.JSX.Element {
  if (choice !== 'own') {
    return <NativeChatPermissionModeName mode={choice} agent={agent} truncate={truncate} />
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
  const t = useTranslate()
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
          <PermissionChoiceRadioItem
            value="own"
            description={ownDescription(chatOwnSupported, t)}
            disabled={disabled}
            onSelect={() => onSelect('own')}
          >
            <AgentPermissionChoiceName choice="own" ownLabel={ownLabel} />
          </PermissionChoiceRadioItem>
        </>
      ) : null}
    </>
  )
}
