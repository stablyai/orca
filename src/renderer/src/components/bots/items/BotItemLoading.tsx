import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

const BAR = 'block max-w-full rounded bg-muted-foreground/15'

export function BotItemLoading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div aria-busy="true" className="min-h-0 flex-1 overflow-hidden">
      <div aria-hidden="true" className="flex min-h-full flex-col">
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3.5 pt-1 pb-2">
          <div>
            <div className="flex h-[21px] items-center">
              <span className={cn(BAR, 'h-3.5 w-3/4 max-w-[365px]')} />
            </div>
            <div className="flex h-6 items-center">
              <span className={cn(BAR, 'h-2.5 w-1/2 max-w-[250px]')} />
            </div>
          </div>
          <div className="flex h-6 min-w-0 items-center gap-1">
            <span className={cn(BAR, 'h-5 w-[38%] max-w-40 rounded-md')} />
            <span className={cn(BAR, 'h-5 w-[32%] max-w-36 rounded-md')} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-4 px-3.5 pt-2 pb-2">
          <dl className="grid grid-cols-[84px_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-xs @max-[284px]:grid-cols-[72px_minmax(0,1fr)]">
            <dt className="leading-6 text-muted-foreground">
              {t('bots.items.field.chat', 'Chat')}
            </dt>
            <dd className="flex h-6 min-w-0 items-center">
              <span className={cn(BAR, 'h-2.5 w-[70%] max-w-[220px]')} />
            </dd>
            <dt className="leading-[18px] text-muted-foreground">
              {t('bots.items.field.doneMeans', 'Done means')}
            </dt>
            <dd className="min-w-0">
              <div className="flex h-[18px] items-center">
                <span className={cn(BAR, 'h-2.5 w-full max-w-[420px]')} />
              </div>
              <div className="flex h-[18px] items-center">
                <span className={cn(BAR, 'h-2.5 w-[62%] max-w-[270px]')} />
              </div>
              <div className="flex h-[18px] items-center">
                <span className={cn(BAR, 'h-2.5 w-[36%] max-w-[150px]')} />
              </div>
            </dd>
          </dl>
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">
              {t('bots.items.view.activity', 'Activity')}
            </div>
            <div className="flex h-[18px] items-center">
              <span className={cn(BAR, 'h-2.5 w-[55%] max-w-[245px]')} />
            </div>
            <div className="flex h-[18px] items-center">
              <span className={cn(BAR, 'h-2.5 w-[36%] max-w-[150px]')} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
