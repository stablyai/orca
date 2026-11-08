import type React from 'react'
import { PanelLeftOpen, Space, Sparkles, WrapText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { DiffNotesSendMenu } from '../../diff/review/DiffNotesSendMenu'
import { DiffNotesPreviewPopover } from './combined-diff-notes-popover'

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
  diffCommentCount,
  diffCommentsForWorktree,
  diffShowWhitespace,
  diffWordWrap,
  file,
  fileTreeCollapsed,
  isAllMode,
  isBranchMode,
  isCommitMode,
  notesCopied,
  onCopyNotes,
  onOpenAlternateDiff,
  onOpenClearNotes,
  onShowFileTree,
  previewDiffComments,
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
  diffCommentCount: number
  diffCommentsForWorktree: DiffComment[]
  diffShowWhitespace: boolean | undefined
  diffWordWrap: boolean | undefined
  file: OpenFile
  fileTreeCollapsed: boolean
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  notesCopied: boolean
  onCopyNotes: () => void
  onOpenAlternateDiff: () => void
  onOpenClearNotes: () => void
  onShowFileTree: () => void
  previewDiffComments: DiffComment[]
  sectionCount: number
  setAllSectionsCollapsed: (collapsed: boolean) => void
  sideBySide: boolean
  toggleDiffShowWhitespace: () => void
  toggleDiffWordWrap: () => void
  toggleSideBySide: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-border bg-background/50 shrink-0">
      <div className="flex min-w-0 items-center gap-2">
        {fileTreeCollapsed && (
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
        <span className="truncate text-xs text-muted-foreground">
          {changedFilesSummary(
            sectionCount,
            (isAllMode || isBranchMode) && branchCompare ? branchCompare.baseRef : null,
            isCommitMode && commitCompare ? commitCompare.compareRef : null,
            t
          )}
        </span>
        {diffCommentCount > 0 && (
          <div className="ml-1 flex shrink-0 items-center overflow-hidden rounded-full border border-border/70 bg-muted/40">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 pl-2 pr-1.5 text-[11px] font-medium leading-none text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                  aria-label={t(
                    'auto.components.editor.CombinedDiffViewer.showAiNotes',
                    'Show {{count}} AI notes',
                    { count: diffCommentCount, defaultValue_one: 'Show {{count}} AI note' }
                  )}
                >
                  <Sparkles className="size-3 text-violet-500 dark:text-violet-400" />
                  <span>
                    {t('auto.components.editor.CombinedDiffViewer.bb84b4c374', 'AI notes')}
                  </span>
                  <span className="rounded-full bg-background/80 px-1 text-[10px] tabular-nums text-muted-foreground">
                    {diffCommentCount}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="bottom" sideOffset={6} className="w-80 p-0">
                <DiffNotesPreviewPopover
                  comments={previewDiffComments}
                  totalCount={diffCommentCount}
                  copied={notesCopied}
                  onCopy={onCopyNotes}
                  onClear={onOpenClearNotes}
                />
              </PopoverContent>
            </Popover>
            <DiffNotesSendMenu
              owner={commentOwner}
              worktreeId={file.worktreeId}
              groupId={activeGroupId ?? file.worktreeId}
              comments={diffCommentsForWorktree}
              actionLabel={t('auto.components.editor.CombinedDiffViewer.send', 'Send')}
              triggerClassName="h-6 gap-1 rounded-none border-l border-border/70 px-2 text-[11px] font-medium leading-none text-foreground/80 hover:bg-accent hover:text-foreground"
              iconClassName="size-3"
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
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
