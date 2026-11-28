import { useTranslate } from '@/i18n/use-translate'
import { NativeChatDetailsDisclosure } from '../diagnostics/NativeChatProviderDetails'

export function NativeChatGoalCheckNotice({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  const newline = text.indexOf('\n')
  return (
    <NativeChatDetailsDisclosure
      summary={t('components.native-chat.goal.checks', '{{count}} checks', {
        count: Number(text.slice(0, newline)),
        defaultValue_one: '{{count}} check'
      })}
    >
      <p className="whitespace-pre-wrap break-words text-sm text-chat-foreground">
        {text.slice(newline + 1)}
      </p>
    </NativeChatDetailsDisclosure>
  )
}
