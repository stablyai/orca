import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useCompactViewport } from '@/lib/compact-viewport'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'

/**
 * Settings is a nav column beside a content column; on a phone the two cannot share a row, so
 * it becomes list → section with a way back, like a phone's own settings app. The content stays
 * mounted while the list shows so scroll-to-section has a target the moment it is revealed.
 */
export function SettingsCompactFrame(props: {
  renderSidebar: (args: { className?: string; onPicked: () => void }) => React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const compact = useCompactViewport()
  const [showList, setShowList] = useState(true)

  if (!compact) {
    return (
      <>
        {props.renderSidebar({ onPicked: () => {} })}
        {props.children}
      </>
    )
  }

  return (
    <>
      {showList
        ? props.renderSidebar({
            className: 'w-full border-r-0',
            onPicked: () => setShowList(false)
          })
        : null}
      <div className={cn('flex min-h-0 flex-1 flex-col', showList && 'hidden')}>
        <div className="flex h-10 shrink-0 items-center border-b border-border px-2">
          <Button variant="ghost" size="sm" onClick={() => setShowList(true)}>
            <ChevronLeft className="size-4" />
            {translate('auto.components.settings.SettingsCompactFrame.allSettings', 'All settings')}
          </Button>
        </div>
        {props.children}
      </div>
    </>
  )
}
