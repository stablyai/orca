import { MessagesSquare, X } from 'lucide-react'
import type { Tab } from '../../../../shared/tab-types'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getTabRootStateClasses,
  getTabStripBorderClasses
} from './drop-indicator'
import { TAB_CONTAINER_WIDTH_CLASSES, TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'
import { translate } from '@/i18n/i18n'

export function RoomTab({
  tab,
  isActive,
  hasTabsToRight,
  onActivate,
  onClose
}: {
  tab: Tab
  isActive: boolean
  hasTabsToRight: boolean
  onActivate: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      data-room-tab-id={tab.entityId}
      data-active={isActive ? 'true' : 'false'}
      className={`group relative flex h-full items-center text-xs outline-none ${TAB_CONTAINER_WIDTH_CLASSES} ${getTabStripBorderClasses(hasTabsToRight)} ${getTabRootStateClasses(isActive)}`}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2"
        aria-current={isActive ? 'page' : undefined}
        onClick={onActivate}
      >
        <MessagesSquare className="size-3 shrink-0" />
        <span className={TAB_LABEL_WIDTH_CLASSES}>{tab.customLabel ?? tab.label}</span>
      </button>
      <button
        type="button"
        className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={translate('rooms.tabs.close', 'Close room tab')}
        onClick={onClose}
      >
        <X className="size-3" />
      </button>
      {isActive ? <span className={ACTIVE_TAB_INDICATOR_CLASSES} /> : null}
    </div>
  )
}
