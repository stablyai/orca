import type React from 'react'
import { PanelLeftOpen, Space, WrapText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffComment } from '../../../../../../shared/file-review/diff-comment-types'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { DiffNotesSendMenu } from '../../diff/review/DiffNotesSendMenu'
import { SendNotesSlot } from '../../review-note-delivery/SendNotesButton'

function changedFilesSummary(
  count: number,
  baseRef: string | null,
  compareRef: string | null,
  t: Translate = translate
): string {
  if (baseRef !== null) {
    return t(
      'auto.components.editor.CombinedDiffViewer.changedFilesVs',
      '{{count}} changed files vs {{baseRef}}',
      { count, baseRef, defaultValue_one: '{{count}} changed file vs {{baseRef}}' }
    )
  }
  if (compareRef !== null) {
    return t(
      'auto.components.editor.CombinedDiffViewer.changedFilesIn',
      '{{count}} changed files in {{compareRef}}',
      { count, compareRef, defaultValue_one: '{{count}} changed file in {{compareRef}}' }
    )
  }
  return t('auto.components.editor.CombinedDiffViewer.changedFiles', '{{count}} changed files', {
    count,
    defaultValue_one: '{{count}} changed file'
  })
}

export function CombinedDiffToolbar({
  activeGroupId,
  allSectionsCollapsed,
  branchCompare,
  commitCompare,
  commentOwner,
  diffCommentsForWorktree,
  diffShowWhitespace,
  diffWordWrap,
  file,
  fileTreeCollapsed,
  isAllMode,
  isBranchMode,
  isCommitMode,
  onOpenAlternateDiff,
  onShowFileTree,
  sectionCount,
  setAllSectionsCollapsed,
  sideBySide,
  toggleDiffShowWhitespace,
  toggleDiffWordWrap,
  toggleSideBySide
}: {
  activeGroupId: string | undefined
  allSectionsCollapsed: boolean
  branchCompare: NonNullable<OpenFile['branchCompare']> | null
  commitCompare: NonNullable<OpenFile['commitCompare']> | null
  commentOwner: DiffCommentOwner | null
  diffCommentsForWorktree: DiffComment[]
  diffShowWhitespace: boolean | undefined
  diffWordWrap: boolean | undefined
  file: OpenFile
  fileTreeCollapsed: boolean
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  onOpenAlternateDiff: () => void
  onShowFileTree: () => void
  sectionCount: number
  setAllSectionsCollapsed: (collapsed: boolean) => void
  sideBySide: boolean
  toggleDiffShowWhitespace: () => void
  toggleDiffWordWrap: () => void
  toggleSideBySide: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const isFocusedTab = useAppStore((s) => s.activeFileId === file.id)
  const hasSections = sectionCount > 0
  return (
    <div
      className={cn(
        'shrink-0 items-center justify-between gap-3 border-b border-border bg-background/50 px-3 py-1.5',
        hasSections ? 'flex' : 'hidden has-[[data-send-notes-slot]_button]:flex'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {hasSections && fileTreeCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t(
                  'auto.components.editor.CombinedDiffViewer.b6c3b84476',
                  'Show file tree'
                )}
                onClick={onShowFileTree}
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.components.editor.CombinedDiffViewer.b6c3b84476', 'Show file tree')}
            </TooltipContent>
          </Tooltip>
        )}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {changedFilesSummary(
            sectionCount,
            (isAllMode || isBranchMode) && branchCompare ? branchCompare.baseRef : null,
            isCommitMode && commitCompare ? commitCompare.compareRef : null,
            t
          )}
        </span>
        <SendNotesSlot className="ml-1">
          <DiffNotesSendMenu
            owner={commentOwner}
            worktreeId={file.worktreeId}
            groupId={activeGroupId ?? file.worktreeId}
            comments={diffCommentsForWorktree}
            align="start"
            batch={{ flush: hasSections }}
            // Only the focused Changes tab opens for the Send review notes shortcut.
            respondToOpenRequest={isFocusedTab}
          />
        </SendNotesSlot>
      </div>
      <div className={hasSections ? 'flex shrink-0 items-center gap-2' : 'hidden'}>
        {file.combinedAlternate && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={onOpenAlternateDiff}
          >
            {file.combinedAlternate.source === 'combined-branch'
              ? t('auto.components.editor.CombinedDiffViewer.3d909843bb', 'Open Branch Diff')
              : t('auto.components.editor.CombinedDiffViewer.982d14bfa5', 'Open All Changes')}
          </button>
        )}
        <button
          className="w-20 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setAllSectionsCollapsed(!allSectionsCollapsed)}
        >
          {allSectionsCollapsed
            ? t('auto.components.editor.CombinedDiffViewer.19c45cfdc0', 'Expand All')
            : t('auto.components.editor.CombinedDiffViewer.ea08dae15b', 'Collapse All')}
        </button>
        <button
          className="w-24 px-2 py-0.5 text-center text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          onClick={toggleSideBySide}
        >
          {sideBySide
            ? t('auto.components.editor.CombinedDiffViewer.f786fd54e1', 'Inline')
            : t('auto.components.editor.CombinedDiffViewer.ec5053c7f5', 'Side by Side')}
        </button>
        <button
          className={`inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-xs transition-colors hover:text-foreground ${
            diffWordWrap === true ? 'bg-accent text-foreground' : 'text-muted-foreground'
          }`}
          onClick={toggleDiffWordWrap}
          aria-pressed={diffWordWrap === true}
        >
          <WrapText className="size-3.5" />
          {diffWordWrap === true
            ? t('auto.components.editor.CombinedDiffViewer.a4420ca1f7', 'Wrap On')
            : t('auto.components.editor.CombinedDiffViewer.dde325ddfe', 'Wrap Off')}
        </button>
        <button
          className={`inline-flex h-6 items-center gap-1 rounded border border-border px-2 text-xs transition-colors hover:text-foreground ${
            diffShowWhitespace === true ? 'bg-accent text-foreground' : 'text-muted-foreground'
          }`}
          onClick={toggleDiffShowWhitespace}
          aria-pressed={diffShowWhitespace === true}
        >
          <Space className="size-3.5" />
          {diffShowWhitespace === true
            ? t('auto.components.editor.CombinedDiffViewer.2e91bc89d1', 'Whitespace On')
            : t('auto.components.editor.CombinedDiffViewer.2bf19c54ad', 'Whitespace Off')}
        </button>
      </div>
    </div>
  )
}
