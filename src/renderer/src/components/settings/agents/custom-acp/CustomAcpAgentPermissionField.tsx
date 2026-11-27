// How new chats with a custom ACP agent answer its permission requests; each chat can change its own.

import type { CustomAcpNewChatPermission } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import {
  nativeChatPermissionModeDescription,
  nativeChatPermissionModeLabel
} from '../../../native-chat/session/options/controls/native-chat-permission-mode-labels'

const MODES: readonly CustomAcpNewChatPermission[] = ['full-access', 'ask']

export function CustomAcpAgentPermissionField({
  value,
  onChange,
  idPrefix
}: {
  value: CustomAcpNewChatPermission
  onChange: (value: CustomAcpNewChatPermission) => void
  idPrefix: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1">
      <Label htmlFor={`${idPrefix}-permission`}>
        {t('settings.agents.customAcp.permission.label', 'Permissions for new chats')}
      </Label>
      <p className="text-xs text-muted-foreground">
        {t(
          'settings.agents.customAcp.permission.description',
          'Orca answers the agent’s permission requests. Each chat can change its own from the composer.'
        )}
      </p>
      <Select
        value={value}
        onValueChange={(next) => onChange(next === 'ask' ? 'ask' : 'full-access')}
      >
        <SelectTrigger id={`${idPrefix}-permission`} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODES.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {nativeChatPermissionModeLabel(mode, t)} ·{' '}
              {nativeChatPermissionModeDescription(mode, null, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
