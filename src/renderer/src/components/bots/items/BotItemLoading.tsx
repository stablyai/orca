import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

const BAR = 'block max-w-full rounded bg-muted-foreground/15'

export function BotItemLoading(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div aria-busy="true" className="min-h-0 flex-1 overflow-hidden">
      <div aria-hidden="true" className="flex min-h-full flex-col">
        <div className="flex shrink-0 flex-col border-b border-border/60 px-3.5 pt-1 pb-3">
          <div className="flex h-[21px] items-center">
            <span className={cn(BAR, 'h-3.5 w-3/4 max-w-[365px]')} />
          </div>
          <div className="flex h-[21px] items-center">
            <span className={cn(BAR, 'h-3.5 w-1/2 max-w-[250px]')} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-4 px-3.5 pt-3.5 pb-2">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              {t('bots.items.field.doneMeans', 'Done when')}
            </div>
            <div className="flex h-[19px] items-center">
              <span className={cn(BAR, 'h-2.5 w-full max-w-[420px]')} />
            </div>
            <div className="flex h-[19px] items-center">
              <span className={cn(BAR, 'h-2.5 w-[62%] max-w-[270px]')} />
            </div>
          </div>
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
