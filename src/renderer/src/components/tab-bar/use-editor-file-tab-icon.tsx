import { GitCompareArrows, Eye, ShieldAlert, ListChecks, Smartphone } from 'lucide-react'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import type { OpenFile } from '../../store/slices/editor'
import { useTabCustomEditor } from '@/store/plugin-custom-editors'
import { PluginContributionIcon } from '../plugins/PluginContributionIcon'

type EditorFileTabIcon = {
  customEditor: ReturnType<typeof useTabCustomEditor>
  /** The tab's icon at any size, for the strip and its hover card. */
  tabIcon: (className: string) => React.ReactNode
  leadingIcon: (isActive: boolean) => React.ReactNode
}

export function useEditorFileTabIcon(file: OpenFile): EditorFileTabIcon {
  const isDiff = file.mode === 'diff'
  const isConflictReview = file.mode === 'conflict-review'
  const isCheckDetails = file.mode === 'check-details'
  const isMarkdownPreviewTab = file.mode === 'markdown-preview'
  const customEditor = useTabCustomEditor(file)
  // Why: simulator tabs reuse this chrome with a synthetic path an icon theme would map to its file icon.
  const ModeIcon = isConflictReview
    ? ShieldAlert
    : isCheckDetails
      ? ListChecks
      : isDiff
        ? GitCompareArrows
        : isMarkdownPreviewTab
          ? Eye
          : file.language === 'simulator'
            ? Smartphone
            : null
  const tabIcon = (className: string): React.ReactNode => (
    <PluginContributionIcon
      url={customEditor?.iconUrl}
      fallback={ModeIcon ?? <FileTypeIcon filePath={file.filePath} className={className} />}
      className={className}
    />
  )
  const leadingIcon = (isActive: boolean): React.ReactNode =>
    isConflictReview ? (
      <ShieldAlert
        className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-orange-400' : 'text-orange-400/70'}`}
      />
    ) : isMarkdownPreviewTab ? (
      <Eye
        className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
      />
    ) : (
      tabIcon(`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`)
    )
  return { customEditor, tabIcon, leadingIcon }
}
