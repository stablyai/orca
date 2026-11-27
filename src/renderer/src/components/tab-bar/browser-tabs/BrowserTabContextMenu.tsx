import { CopyX, Files, Pin, PinOff, Volume2, VolumeX, X } from 'lucide-react'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { TabWorkspaceLayoutMenuSection } from '../pane-actions/TabWorkspaceLayoutMenuSection'
import { CopyTabIdMenuItem } from '../pane-actions/CopyTabIdMenuItem'
import { BrowserTabOpenExternallyItem } from './browser-tab-open-externally-item'
import { CloseSplitPaneMenuItem } from '../pane-actions/CloseSplitPaneMenuItem'

export function BrowserTabContextMenu({
  tab,
  unifiedTabId,
  groupId,
  isPinned,
  tabCount,
  showAudioControl,
  audioMuted,
  toggleAudioMutedLabel,
  onToggleAudioMuted,
  onDuplicate,
  onTogglePin,
  onClose,
  onCloseOthers,
  onCloseSplitPane,
  onOpenExternally
}: {
  tab: BrowserWorkspace
  unifiedTabId: string
  groupId: string
  isPinned: boolean
  tabCount: number
  showAudioControl: boolean
  audioMuted: boolean
  toggleAudioMutedLabel: string
  onToggleAudioMuted: () => void
  onDuplicate?: () => void
  onTogglePin: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseSplitPane?: () => void
  onOpenExternally: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ContextMenuContent
      animation="none"
      className={cn(
        'rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]',
        'min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap'
      )}
    >
      <TabWorkspaceLayoutMenuSection
        unifiedTabId={unifiedTabId}
        groupId={groupId}
        trailingSeparator
      />
      {onDuplicate ? (
        <>
          <ContextMenuItem onSelect={onDuplicate}>
            <Files className="size-3.5" />
            {t('auto.components.tab.bar.BrowserTab.5d6e89891f', 'Duplicate Tab')}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem onSelect={onTogglePin}>
        {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        {isPinned
          ? t('auto.components.tab.bar.BrowserTab.c5aaee8c39', 'Unpin Tab')
          : t('auto.components.tab.bar.BrowserTab.911542656f', 'Pin Tab')}
      </ContextMenuItem>
      {showAudioControl ? (
        <ContextMenuItem onSelect={onToggleAudioMuted}>
          {audioMuted ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
          {toggleAudioMutedLabel}
        </ContextMenuItem>
      ) : null}
      <CopyTabIdMenuItem menuKind="context" unifiedTabId={unifiedTabId} />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
        <X className="size-3.5" />
        {t('auto.components.tab.bar.BrowserTab.1611a1324b', 'Close')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCloseOthers} disabled={tabCount <= 1}>
        <CopyX className="size-3.5" />
        {t('components.tab.bar.BrowserTab.closeOthers', 'Close Others')}
      </ContextMenuItem>
      <CloseSplitPaneMenuItem menuKind="context" onCloseSplitPane={onCloseSplitPane} />
      <BrowserTabOpenExternallyItem tab={tab} onOpen={onOpenExternally} />
    </ContextMenuContent>
  )
}
