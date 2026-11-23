import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'

/** The bot (or anyone) changed a home file under the owner's unsaved edit. */
export function BotFileChangedNotice({
  fileName,
  actions
}: {
  fileName: string
  actions?: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2 text-status-warning"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1 text-xs leading-snug">
        {t('settings.bots.fileChangedOnDisk', '{{file}} changed on disk.', {
          file: fileName
        })}
      </p>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}
