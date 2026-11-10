import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { SecuritySurface } from '@/components/ui/security-surface'
import { NativeChatSessionOptionRows } from '../../session/options/controls/NativeChatSessionOptionRows'
import { runSessionOptionSurfaceCall } from '../../session/options/controls/native-chat-session-option-surface-call'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'

export function NativeChatClaudeSettingsCommand({
  transport,
  command
}: {
  transport: Pick<NativeChatStructuredComposerTransport, 'optionSnapshot' | 'optionsSurface'>
  command: string
}): React.JSX.Element {
  const t = useTranslate()
  const [pending, setPending] = useState<string | null>(null)
  const options = transport.optionSnapshot.filter((option) =>
    command === 'permissions' ? option.id === 'permissionMode' : option.id !== 'model'
  )
  return (
    <SecuritySurface>
      <section className="mb-2 rounded-md border border-border bg-card p-3 text-sm text-card-foreground">
        <p className="mb-2 font-medium">
          {t('components.native-chat.commands.sessionSettings', 'Session settings')}
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          {t(
            'components.native-chat.commands.settingsScope',
            'These controls apply to this chat. Use Claude’s terminal for additional configuration or individual permission rules.'
          )}
        </p>
        <NativeChatSessionOptionRows
          options={options}
          shownReason={null}
          pendingIds={new Set(pending ? [pending] : [])}
          onSet={(option, value) => {
            if (pending === null) {
              runSessionOptionSurfaceCall(option.id, setPending, () =>
                transport.optionsSurface.setOption(option.id, value)
              )
            }
          }}
          onAction={(option) => {
            if (pending === null) {
              runSessionOptionSurfaceCall(option.id, setPending, () =>
                transport.optionsSurface.invokeAction(option.id)
              )
            }
          }}
        />
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t(
              'components.native-chat.commands.noSettings',
              'This host does not expose these session settings.'
            )}
          </p>
        )}
      </section>
    </SecuritySurface>
  )
}
