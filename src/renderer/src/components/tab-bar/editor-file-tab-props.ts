import type { GitFileStatus } from '../../../../shared/git/status/git-status-types'
import type { OpenFile } from '../../store/slices/editor'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import type { DropIndicator } from './drop-indicator'

export type EditorFileTabProps = {
  file: OpenFile & { tabId?: string }
  isActive: boolean
  isPinned: boolean
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  tabCount: number
  gitStatus: GitFileStatus | null
  onActivate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  onCloseToLeft: () => void
  onCloseSplitPane?: () => void
  onCloseAll: () => void
  onMakePermanent?: () => void
  onTogglePin: () => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
}
