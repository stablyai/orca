import type React from 'react'
import { PanelLeftOpen, Space, Sparkles, WrapText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import { DiffNotesSendMenu } from '../../DiffNotesSendMenu'
import { DiffNotesPreviewPopover } from './combined-diff-notes-popover'

export function CombinedDiffToolbar({
  activeGroupId,
  allSectionsCollapsed,
  branchCompare,
  commitCompare,
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
                aria-label={translate(
                  'auto.components.editor.CombinedDiffViewer.b6c3b84476',
                  'Show file tree'
                )}
                onClick={onShowFileTree}
              >
                <PanelLeftOpen className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.editor.CombinedDiffViewer.b6c3b84476', 'Show file tree')}
            </TooltipContent>
          </Tooltip>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {sectionCount}{' '}
          {translate('auto.components.editor.CombinedDiffViewer.7e7ca60816', 'changed files')}
          {(isAllMode || isBranchMode) && branchCompare
            ? translate('auto.components.editor.CombinedDiffViewer.6094135eec', ' vs {{value0}}', {
                value0: branchCompare.baseRef
              })
            : ''}
          {isCommitMode && commitCompare
            ? translate('auto.components.editor.CombinedDiffViewer.724a13568d', ' in {{value0}}', {
                value0: commitCompare.compareRef
              })
            : ''}
        </span>
        {diffCommentCount > 0 && (
          <div className="ml-1 flex shrink-0 items-center overflow-hidden rounded-full border border-border/70 bg-muted/40">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 items-center gap-1 pl-2 pr-1.5 text-[11px] font-medium leading-none text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                  aria-label={translate(
                    'auto.components.editor.CombinedDiffViewer.8f68ad9ca9',
                    'Show {{value0}} AI {{value1}}',
                    {
                      value0: diffCommentCount,
                      value1: diffCommentCount === 1 ? 'note' : 'notes'
                    }
                  )}
                >
                  <Sparkles className="size-3 text-violet-500 dark:text-violet-400" />
                  <span>
                    {translate('auto.components.editor.CombinedDiffViewer.bb84b4c374', 'AI notes')}
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
              worktreeId={file.worktreeId}
              groupId={activeGroupId ?? file.worktreeId}
              comments={diffCommentsForWorktree}
              actionLabel="Send"
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
              ? translate(
                  'auto.components.editor.CombinedDiffViewer.3d909843bb',
                  'Open Branch Diff'
                )
              : translate(
                  'auto.components.editor.CombinedDiffViewer.982d14bfa5',
                  'Open All Changes'
                )}
          </button>
        )}
        <button
          className="w-20 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setAllSectionsCollapsed(!allSectionsCollapsed)}
        >
          {allSectionsCollapsed
            ? translate('auto.components.editor.CombinedDiffViewer.19c45cfdc0', 'Expand All')
            : translate('auto.components.editor.CombinedDiffViewer.ea08dae15b', 'Collapse All')}
        </button>
        <button
          className="w-24 px-2 py-0.5 text-center text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          onClick={toggleSideBySide}
        >
          {sideBySide
            ? translate('auto.components.editor.CombinedDiffViewer.f786fd54e1', 'Inline')
            : translate('auto.components.editor.CombinedDiffViewer.ec5053c7f5', 'Side by Side')}
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
            ? translate('auto.components.editor.CombinedDiffViewer.a4420ca1f7', 'Wrap On')
            : translate('auto.components.editor.CombinedDiffViewer.dde325ddfe', 'Wrap Off')}
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
            ? translate('auto.components.editor.CombinedDiffViewer.2e91bc89d1', 'Whitespace On')
            : translate('auto.components.editor.CombinedDiffViewer.2bf19c54ad', 'Whitespace Off')}
        </button>
      </div>
    </div>
  )
}
