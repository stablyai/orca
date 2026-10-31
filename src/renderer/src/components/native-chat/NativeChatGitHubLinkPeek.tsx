import { Button } from '@/components/ui/button'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { WorkItemStateBadge } from '@/components/github/work-item-state-badge'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { DiffLineCounts } from '@/components/right-sidebar/source-control/listing/diff-line-counts'
import { translate } from '@/i18n/i18n'
import { parseGitHubIssueOrPRLink, type GitHubIssueOrPRLink } from '../../../../shared/github/links'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  githubLinkPreviewKey,
  loadGitHubLinkPreview,
  readCachedGitHubLinkPreview
} from './native-chat-github-link-preview'
import { githubLinkBelongsToRepo, type NativeChatGitHubRepo } from './native-chat-github-repo'
import { useNativeChatHoverPreview } from './use-native-chat-hover-preview'

function PeekFooter({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {item.author ? (
        <>
          <GitHubUserAvatar
            login={item.author}
            avatarUrl={item.authorAvatarUrl}
            className="size-4"
          />
          <span className="min-w-0 truncate">{item.author}</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      {item.updatedAt ? (
        <span className="shrink-0">
          {translate('components.native-chat.githubPeek.updated', 'updated {{time}}', {
            time: formatRelativeTime(item.updatedAt)
          })}
        </span>
      ) : null}
      {item.type === 'pr' && (item.additions || item.deletions) ? (
        <>
          <span aria-hidden>·</span>
          <DiffLineCounts added={item.additions} removed={item.deletions} size="sm" />
        </>
      ) : null}
      {item.type === 'issue' && item.commentCount !== undefined ? (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0">
            {item.commentCount === 1
              ? translate('components.native-chat.githubPeek.oneComment', '1 comment')
              : translate('components.native-chat.githubPeek.comments', '{{count}} comments', {
                  count: item.commentCount
                })}
          </span>
        </>
      ) : null}
    </div>
  )
}

export function NativeChatGitHubPeekBody({
  repo,
  link
}: {
  repo: Repo
  link: GitHubIssueOrPRLink
}): React.JSX.Element {
  const { state, retry } = useNativeChatHoverPreview(
    githubLinkPreviewKey(repo, link),
    () => readCachedGitHubLinkPreview(repo, link),
    () => loadGitHubLinkPreview(repo, link)
  )
  return (
    <div className="flex flex-col gap-1.5">
      {/* Known from the URL, so the card has a header before the lookup answers. */}
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <GitHubIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {link.slug.owner}/{link.slug.repo}
        </span>
        <span className="shrink-0 font-mono">#{link.number}</span>
        {state.status === 'ready' ? (
          <WorkItemStateBadge
            item={state.value}
            closedIssue="neutral"
            className="ml-auto h-4.5 px-1.5 text-2xs"
          />
        ) : null}
      </div>
      {state.status === 'ready' ? (
        <>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">
            {state.value.title}
          </div>
          {state.value.type === 'issue' && state.value.labels.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {state.value.labels.slice(0, 4).map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-border px-1.5 text-3xs text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          <PeekFooter item={state.value} />
        </>
      ) : state.status === 'loading' ? (
        <div aria-hidden className="flex flex-col gap-1.5 motion-safe:animate-pulse">
          <div className="h-3.5 w-11/12 rounded bg-muted" />
          <div className="h-3.5 w-1/2 rounded bg-muted" />
          <div className="mt-0.5 h-3 w-1/3 rounded bg-muted" />
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>
            {translate('components.native-chat.githubPeek.unavailable', 'Preview unavailable.')}
          </span>
          <Button variant="link" size="xs" onClick={retry}>
            {translate('components.native-chat.githubPeek.retry', 'Retry')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** A PR or issue link into the chat's own GitHub repo, or null when the link isn't one. */
export function resolveGitHubPeekLink(
  githubRepo: NativeChatGitHubRepo | null,
  href: string
): GitHubIssueOrPRLink | null {
  const link = githubRepo ? parseGitHubIssueOrPRLink(href) : null
  return githubRepo && link && githubLinkBelongsToRepo(githubRepo, link.slug) ? link : null
}
