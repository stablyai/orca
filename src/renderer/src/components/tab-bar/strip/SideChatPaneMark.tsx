import type { Translate } from '@/i18n/use-translate'

export function SideChatPaneMark({ t }: { t: Translate }) {
  return (
    <span className="flex shrink-0 items-center border-r border-border/70 px-1.5">
      <span className="rounded-sm border border-border bg-muted px-1 text-3xs font-medium text-muted-foreground">
        {t('components.native-chat.currentSideChat.mark', 'btw')}
      </span>
    </span>
  )
}
