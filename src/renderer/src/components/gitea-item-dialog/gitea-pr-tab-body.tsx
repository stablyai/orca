import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { GiteaIssueComments } from '@/components/gitea-item-dialog/gitea-issue-comments'
import { GiteaPrChecks } from '@/components/gitea-item-dialog/gitea-pr-checks'
import { GiteaPrFileDiff } from '@/components/gitea-item-dialog/gitea-pr-file-diff'
import { Button } from '@/components/ui/button'
import type {
  GiteaComment,
  GiteaPRCheck,
  GiteaPRFile,
  GiteaPRReviewComment
} from '../../../../shared/gitea/gitea-types'
import type { GiteaIssueScope } from '@/store/slices/gitea/gitea'
import { useTranslate } from '@/i18n/use-translate'

type GiteaPrTabBodyProps = {
  tab: 'conversation' | 'files' | 'checks'
  body?: string
  comments: GiteaComment[]
  files: GiteaPRFile[]
  /** The PR's changed-file count, which can exceed the files Orca loads. */
  totalChangedFiles?: number
  checks: GiteaPRCheck[] | null
  scope: GiteaIssueScope
  baseSha: string
  headSha: string
  isDark: boolean
  sideBySide: boolean
  onToggleSideBySide: () => void
  reviewComments: GiteaPRReviewComment[]
  onAddReviewComment: (path: string, line: number, body: string) => Promise<boolean>
}

export function GiteaPrTabBody({
  tab,
  body,
  comments,
  files,
  totalChangedFiles,
  checks,
  scope,
  baseSha,
  headSha,
  isDark,
  sideBySide,
  onToggleSideBySide,
  reviewComments,
  onAddReviewComment
}: GiteaPrTabBodyProps): React.JSX.Element {
  const t = useTranslate()
  if (tab === 'conversation') {
    return (
      <>
        <section className="border-b border-border/40 px-4 py-4">
          {body ? (
            <CommentMarkdown content={body} className="text-[14px] leading-relaxed" />
          ) : (
            <p className="text-sm italic text-muted-foreground">
              {t('auto.components.gitea.pr.tab.body.1fe3a05742', 'No description provided.')}
            </p>
          )}
        </section>
        <GiteaIssueComments comments={comments} />
      </>
    )
  }
  if (tab === 'files') {
    return (
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center justify-end gap-3">
          {files.length > 0 &&
          totalChangedFiles !== undefined &&
          totalChangedFiles > files.length ? (
            <p className="mr-auto text-xs text-muted-foreground">
              {t(
                'auto.components.gitea.pr.tab.body.truncatedFiles',
                'Showing {{shown}} of {{total}} changed files. Open the pull request in Gitea for the rest.',
                { shown: files.length, total: totalChangedFiles }
              )}
            </p>
          ) : null}
          <Button variant="outline" size="xs" onClick={onToggleSideBySide}>
            {sideBySide
              ? t('auto.components.gitea.pr.tab.body.413feaa83a', 'Inline')
              : t('auto.components.gitea.pr.tab.body.5372c28376', 'Side by side')}
          </Button>
        </div>
        {files.length === 0 ? (
          <p className="px-1 py-6 text-sm text-muted-foreground">
            {t('auto.components.gitea.pr.tab.body.53ab0c5a49', 'No changed files.')}
          </p>
        ) : (
          files.map((file) => (
            <GiteaPrFileDiff
              key={file.path}
              file={file}
              scope={scope}
              baseSha={baseSha}
              headSha={headSha}
              isDark={isDark}
              sideBySide={sideBySide}
              reviewComments={reviewComments.filter((c) => c.path === file.path)}
              onAddReviewComment={onAddReviewComment}
            />
          ))
        )}
      </div>
    )
  }
  return <GiteaPrChecks checks={checks} />
}
