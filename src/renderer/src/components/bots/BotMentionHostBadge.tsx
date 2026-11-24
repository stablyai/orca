import { Server } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'

/** The paired server an `@` row's bot runs on, as the sidebar's bot row shows it; the list resolves the label once (useBotHostLabels). */
export function BotMentionHostBadge({
  label,
  inline,
  offline
}: {
  label: string | null | undefined
  inline?: boolean
  offline?: boolean
}): React.JSX.Element | null {
  if (!label) {
    return null
  }
  return inline ? (
    <BotMentionHostText label={label} offline={offline} />
  ) : (
    <WorktreeHostContextBadge label={label} />
  )
}

export function BotMentionHostText({
  label,
  offline
}: {
  label: string
  offline?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const title = offline
    ? t('components.native-chat.hostOutage.offline', '{{hostName}} is offline', { hostName: label })
    : label
  return (
    <span title={title} className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Server className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" aria-hidden={offline || undefined}>
        {label}
      </span>
      {offline && <span className="sr-only">{title}</span>}
    </span>
  )
}
