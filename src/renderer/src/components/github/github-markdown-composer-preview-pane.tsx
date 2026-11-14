import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { useTranslate } from '@/i18n/use-translate'

export function GitHubMarkdownComposerPreviewPane({
  value,
  minHeightClassName,
  previewGithubRepo
}: {
  value: string
  minHeightClassName: string
  previewGithubRepo: GitHubOwnerRepo | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className={`github-markdown-composer-preview scrollbar-sleek max-h-[360px] overflow-y-auto ${minHeightClassName}`}
    >
      {value.trim() ? (
        <CommentMarkdown
          content={value}
          variant="document"
          githubRepo={previewGithubRepo}
          className="min-w-0 max-w-full overflow-hidden break-words text-[13px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
        />
      ) : (
        <p className="text-[13px] italic text-muted-foreground">
          {t('auto.components.github.GitHubMarkdownComposer.8f1c2d4e6a', 'Nothing to preview')}
        </p>
      )}
    </div>
  )
}
