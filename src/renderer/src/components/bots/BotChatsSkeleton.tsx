import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

export function BotChatsSkeleton({ toolbar = false }: { toolbar?: boolean }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="status" className={toolbar ? '@container px-2 pt-2.5' : undefined}>
      <span className="sr-only">{t('bots.chats.loading', 'Loading chats…')}</span>
      <div aria-hidden="true">
        {toolbar ? (
          <div className="flex items-center gap-1.5 px-0.5 pb-2">
            <div className="h-7 min-w-0 flex-1 rounded-md bg-muted/60" />
            <div className="h-7 w-20 shrink-0 rounded-md bg-muted/60 @max-[240px]:w-7" />
          </div>
        ) : null}
        {['w-24', 'w-32', 'w-20'].map((titleWidth) => (
          <div key={titleWidth} className="flex min-w-0 gap-2 py-1.5 pr-2 pl-5">
            <div className="mt-0.5 size-3.5 shrink-0 rounded bg-muted/60" />
            <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
              <div className={cn('h-3 max-w-full rounded bg-muted', titleWidth)} />
              <div className="h-2.5 w-3/4 rounded bg-muted/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
