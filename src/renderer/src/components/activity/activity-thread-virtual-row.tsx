import type React from 'react'
import { translate } from '@/i18n/i18n'
import { isClearableActivityThread } from './activity-clear-completed'
import { ActivityStatusGroupHeader } from './activity-thread-controls'
import { ActivityThreadRow } from './activity-thread-row'
import type { ActivityVirtualItemDescriptor } from './activity-thread-virtual-items'

export function ActivityThreadVirtualRow({
  item,
  collapsed,
  onToggleGroup,
  selectedPaneKey,
  onSelectThread,
  onJumpToWorkspace,
  onMarkThreadRead,
  onMarkThreadUnread,
  onClearThread,
  canJumpToWorkspace,
  compactMode,
  allowMarkUnreadWhenSelected,
  showJumpAction
}: {
  item: ActivityVirtualItemDescriptor
  collapsed: boolean
  onToggleGroup: (groupKey: string) => void
  selectedPaneKey: string | null
  onSelectThread: Parameters<typeof ActivityThreadRow>[0]['onSelect']
  onJumpToWorkspace: Parameters<typeof ActivityThreadRow>[0]['onJump']
  onMarkThreadRead: Parameters<typeof ActivityThreadRow>[0]['onMarkRead']
  onMarkThreadUnread: Parameters<typeof ActivityThreadRow>[0]['onMarkUnread']
  onClearThread?: Parameters<typeof ActivityThreadRow>[0]['onClear']
  canJumpToWorkspace: (
    thread: Extract<ActivityVirtualItemDescriptor, { type: 'thread' }>['thread']
  ) => boolean
  compactMode: boolean
  allowMarkUnreadWhenSelected: boolean
  showJumpAction: boolean
}): React.JSX.Element {
  if (item.type === 'header') {
    return (
      <div
        role="group"
        aria-label={translate(
          'auto.components.activity.ActivityPrototypePage.a2b4437bfb',
          '{{value0}} activity',
          { value0: item.group.label }
        )}
        className="pb-1"
      >
        <ActivityStatusGroupHeader
          group={item.group}
          collapsed={collapsed}
          onToggle={() => onToggleGroup(item.group.key)}
        />
      </div>
    )
  }
  return (
    <div className="pb-1">
      <ActivityThreadRow
        thread={item.thread}
        selected={item.thread.paneKey === selectedPaneKey}
        onSelect={onSelectThread}
        onJump={onJumpToWorkspace}
        onMarkRead={onMarkThreadRead}
        onMarkUnread={onMarkThreadUnread}
        onClear={onClearThread}
        canJump={canJumpToWorkspace(item.thread)}
        canClear={isClearableActivityThread(item.thread) && !!onClearThread}
        compactMode={compactMode}
        disableMarkUnread={item.thread.paneKey === selectedPaneKey && !allowMarkUnreadWhenSelected}
        showJumpAction={showJumpAction}
      />
    </div>
  )
}
