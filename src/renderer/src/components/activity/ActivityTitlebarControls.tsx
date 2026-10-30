import { ArrowLeft, Bell } from 'lucide-react'

import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useActivityUnreadCount } from './useActivityUnreadCount'
import { translate } from '@/i18n/i18n'

export function ActivityTitlebarControls(): React.JSX.Element {
  const unreadCount = useActivityUnreadCount()
  const closeActivityPage = useAppStore((s) => s.closeActivityPage)

  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-3 border-l border-border px-3">
      <div
        className="flex min-w-0 items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* Activity hides sidebar navigation, so provide a dedicated Back action as Settings does. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={closeActivityPage}
              aria-label={translate(
                'auto.components.activity.ActivityTitlebarControls.dc708f3eff',
                'Close agents'
              )}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.activity.ActivityTitlebarControls.dc708f3eff',
              'Close agents'
            )}
          </TooltipContent>
        </Tooltip>
        <Bell className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">
          {translate('auto.components.activity.ActivityTitlebarControls.d6a8de3934', 'agents')}
        </span>
        <Badge variant="secondary" className="h-5 px-1.5 text-[11px] font-normal">
          {translate(
            'auto.components.activity.ActivityTitlebarControls.unreadCount',
            '{{count}} unread',
            { count: unreadCount, defaultValue_one: '{{count}} unread' }
          )}
        </Badge>
      </div>
    </div>
  )
}
