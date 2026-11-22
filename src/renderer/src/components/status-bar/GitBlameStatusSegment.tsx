import { GitCommitHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { getRuntimeGitCommitCompare } from '@/runtime/source-control/git/runtime-git-diff-client'
import { useFocusedLineBlame, type FocusedLineBlame } from '../editor/blame/git-blame-line-store'
import {
  formatBlameCommitDetails,
  formatLineBlameSummary
} from '../editor/blame/git-blame-presentation'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './composition/status-bar-context-menu-policy'

async function openBlamedCommit(blame: FocusedLineBlame, failureMessage: string): Promise<void> {
  const git = blame.git
  if (blame.line.kind !== 'commit' || !git?.worktreeId) {
    return
  }
  const { commit } = blame.line
  try {
    const result = await getRuntimeGitCommitCompare(git, commit.oid)
    if (result.summary.status !== 'ready') {
      throw new Error(result.summary.errorMessage ?? failureMessage)
    }
    useAppStore
      .getState()
      .openCommitAllDiffs(
        git.worktreeId,
        git.worktreePath,
        result.summary,
        result.entries,
        commit.summary
      )
  } catch (error) {
    toast.error(error instanceof Error ? error.message : failureMessage)
  }
}

export function GitBlameStatusSegment(): React.JSX.Element | null {
  const t = useTranslate()
  const blame = useFocusedLineBlame()
  // Derived, not stored: only the visible editor's blame shows, so switching worktrees or tabs hides it.
  const visible = useAppStore(
    (state) =>
      !!blame &&
      !blame.released &&
      state.activeTabType === 'editor' &&
      state.activeFileId === blame.fileId
  )
  if (!blame || !visible) {
    return null
  }
  const summary = formatLineBlameSummary(blame.line)
  const details = blame.line.kind === 'commit' ? formatBlameCommitDetails(blame.line.commit) : null
  const canOpen = details !== null && !blame.stale && blame.git?.worktreeId != null
  const failureMessage = t('editor.gitBlame.openCommitFailed', 'Failed to load commit diff')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          disabled={!canOpen}
          onClick={() => void openBlamedCommit(blame, failureMessage)}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
          aria-label={t('editor.gitBlame.statusAriaLabel', 'Git blame: {{summary}}', { summary })}
        >
          <GitCommitHorizontal className={`size-3 shrink-0 ${blame.stale ? 'opacity-50' : ''}`} />
          <span
            className={`max-w-64 truncate text-[11px] font-medium ${blame.stale ? 'opacity-50' : ''}`}
          >
            {summary}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-80">
        {details ? (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{details.heading}</span>
            <span className="text-muted-foreground">
              {details.date} · <span className="font-mono">{details.shortOid}</span>
            </span>
            <span>{details.summary}</span>
            {canOpen ? (
              <span className="text-muted-foreground">
                {t('editor.gitBlame.openCommitHint', 'Click to open the commit')}
              </span>
            ) : null}
          </div>
        ) : (
          summary
        )}
      </TooltipContent>
    </Tooltip>
  )
}
