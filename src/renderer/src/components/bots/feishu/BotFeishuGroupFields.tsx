import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'

export function BotFeishuGroupFields({
  chatId,
  members,
  onChatId,
  onMembers,
  disabled,
  invalid
}: {
  chatId: string
  members: string
  onChatId: (value: string) => void
  onMembers: (value: string) => void
  disabled: boolean
  invalid: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">
        {t('bots.feishu.groupSettings', 'Test group (optional)')}
      </summary>
      <div className="mt-3 space-y-3">
        <div className="space-y-2">
          <Label htmlFor="feishu-group-chat">{t('bots.feishu.groupId', 'Test group ID')}</Label>
          <Input
            id="feishu-group-chat"
            placeholder={t('bots.feishu.groupIdPlaceholder', 'oc_…')}
            autoComplete="off"
            spellCheck={false}
            value={chatId}
            onChange={(event) => onChatId(event.target.value)}
            disabled={disabled}
            aria-invalid={invalid}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="feishu-group-members">
            {t('bots.feishu.groupMembers', 'Allowed member open IDs')}
          </Label>
          <Input
            id="feishu-group-members"
            placeholder={t('bots.feishu.groupMembersPlaceholder', 'ou_…, ou_…')}
            autoComplete="off"
            spellCheck={false}
            value={members}
            onChange={(event) => onMembers(event.target.value)}
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby="feishu-group-help"
          />
          <p id="feishu-group-help" className="text-xs text-muted-foreground">
            {t(
              'bots.feishu.groupHelp',
              'Use the test group ID and member open IDs for this app. Enable receiving group mentions and add the app to the group.'
            )}
          </p>
        </div>
      </div>
    </details>
  )
}
