import type React from 'react'
import { Activity } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { setZotzBackgroundPanelTarget } from './zotz-background-panel-target'

/** Right sidebar tab: the active chat's background work (tests, scripts, subagents) with Stop. */
export default function ZotzBackgroundPanel(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto scrollbar-sleek">
      <div className="flex h-9 shrink-0 items-center px-3 text-xs font-medium text-muted-foreground">
        {t('zotz.background.title', 'Background')}
      </div>
      {/* The active chat portals its tasks here; :empty shows the placeholder below. The strip caps
          its list for the space above the chat; the panel has room, so it shows every row. */}
      <div
        ref={setZotzBackgroundPanelTarget}
        className="peer flex flex-col [&_.max-h-40]:max-h-none"
      />
      <div className="hidden flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted-foreground peer-empty:flex">
        <Activity className="size-4" />
        <span>
          {t(
            'zotz.background.empty',
            'Nothing is running in the background for this chat. Tests, scripts and subagents the agent starts show up here.'
          )}
        </span>
      </div>
    </div>
  )
}
