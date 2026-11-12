import { CircleDot, GitMerge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'
import type { GitLabWorkItem } from '../../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  gitLabLinkPreviewKey,
  jiraLinkPreviewKey,
  loadGitLabLinkPreview,
  loadJiraLinkPreview,
  readCachedGitLabLinkPreview,
  readCachedJiraLinkPreview,
  type GitLabChatLink,
  type JiraChatLink
} from './native-chat-tracker-link-previews'
import { useNativeChatHoverPreview, type HoverPreviewState } from './use-native-chat-hover-preview'
import { trackerStateLabel } from './native-chat-tracker-state-label'

/** Title and status of a linked Jira issue, cached across chips and hover cards. */
export function useJiraIssuePreview(link: JiraChatLink): {
  state: HoverPreviewState<JiraIssue>
  retry: () => void
} {
  return useNativeChatHoverPreview(
    jiraLinkPreviewKey(link),
    () => readCachedJiraLinkPreview(link),
    () => loadJiraLinkPreview(link)
  )
}

/** Title and state of a linked GitLab issue or merge request, cached across chips and hover cards. */
export function useGitLabWorkItemPreview(
  repo: Repo,
  link: GitLabChatLink
): { state: HoverPreviewState<GitLabWorkItem>; retry: () => void } {
  return useNativeChatHoverPreview(
    gitLabLinkPreviewKey(repo, link),
    () => readCachedGitLabLinkPreview(repo, link),
    () => loadGitLabLinkPreview(repo, link)
  )
}

// Jira status categories: to do, in progress, done.
const JIRA_CATEGORY_DOT: Record<string, string> = {
  new: 'bg-muted-foreground',
  indeterminate: 'bg-sky-500',
  done: 'bg-emerald-500'
}

/** The issue's status category as a colored dot. */
export function JiraStatusDot({ categoryKey }: { categoryKey: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        JIRA_CATEGORY_DOT[categoryKey] ?? 'bg-muted-foreground'
      )}
    />
  )
}

const GITLAB_STATE_CLASS: Record<GitLabWorkItem['state'], string> = {
  opened: 'text-emerald-600 dark:text-emerald-400',
  draft: 'text-muted-foreground',
  merged: 'text-violet-600 dark:text-violet-400',
  closed: 'text-red-600 dark:text-red-400',
  locked: 'text-muted-foreground'
}

/** Issue or merge request icon, colored by state once known. */
export function GitLabItemIcon({
  type,
  state
}: {
  type: 'issue' | 'mr'
  state?: GitLabWorkItem['state']
}): React.JSX.Element {
  const Icon = type === 'mr' ? GitMerge : CircleDot
  return <Icon aria-hidden className={cn('size-3 shrink-0', state && GITLAB_STATE_CLASS[state])} />
}

/** Placeholder lines while a lookup is in flight. */
function Skeleton(): React.JSX.Element {
  return (
    <div aria-hidden className="flex flex-col gap-1.5 motion-safe:animate-pulse">
      <div className="h-3.5 w-11/12 rounded bg-muted" />
      <div className="h-3 w-1/3 rounded bg-muted" />
    </div>
  )
}

/** Shown when the lookup fails, with a way to ask again. */
function Unavailable({ retry }: { retry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{t('components.native-chat.trackerPeek.unavailable', 'Preview unavailable.')}</span>
      <Button variant="link" size="xs" onClick={retry}>
        {t('components.native-chat.trackerPeek.retry', 'Retry')}
      </Button>
    </div>
  )
}

/** When the item last changed, in the reader's locale. */
function Updated({ at }: { at: string }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <span className="shrink-0">
      {t('components.native-chat.trackerPeek.updated', 'updated {{time}}', {
        time: formatRelativeTime(at, intlLocale)
      })}
    </span>
  )
}

/** Title, status, type and assignee of a Jira issue, read through Orca's Jira connection. */
export function NativeChatJiraPeekBody({ link }: { link: JiraChatLink }): React.JSX.Element {
  const t = useTranslate()
  const { issueKey } = link
  const { state, retry } = useJiraIssuePreview(link)
  const issue = state.status === 'ready' ? state.value : null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono">{issueKey}</span>
        {issue ? <span className="min-w-0 truncate">· {issue.issueType.name}</span> : null}
        {issue ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <JiraStatusDot categoryKey={issue.status.categoryKey} />
            {issue.status.name}
          </span>
        ) : null}
      </div>
      {issue ? (
        <>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">{issue.title}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {issue.assignee?.displayName ??
                t('components.native-chat.trackerPeek.unassigned', 'Unassigned')}
            </span>
            {issue.priority ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0">{issue.priority.name}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <Updated at={issue.updatedAt} />
          </div>
        </>
      ) : state.status === 'loading' ? (
        <Skeleton />
      ) : (
        <Unavailable retry={retry} />
      )}
    </div>
  )
}

/** Title, state and author of a GitLab merge request or issue, read through Orca's GitLab sign-in. */
export function NativeChatGitLabPeekBody({
  repo,
  link
}: {
  repo: Repo
  link: GitLabChatLink
}): React.JSX.Element {
  const t = useTranslate()
  const { state, retry } = useGitLabWorkItemPreview(repo, link)
  const item = state.status === 'ready' ? state.value : null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <GitLabItemIcon type={link.type} state={item?.state} />
        <span className="min-w-0 truncate">{link.slug.path}</span>
        <span className="shrink-0 font-mono">
          {link.type === 'mr' ? '!' : '#'}
          {link.number}
        </span>
        {item ? <span className="ml-auto shrink-0">{trackerStateLabel(t, item.state)}</span> : null}
      </div>
      {item ? (
        <>
          <div className="line-clamp-2 text-sm font-semibold text-foreground">{item.title}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {item.author ? <span className="min-w-0 truncate">{item.author}</span> : null}
            {item.author ? <span aria-hidden>·</span> : null}
            <Updated at={item.updatedAt} />
          </div>
        </>
      ) : state.status === 'loading' ? (
        <Skeleton />
      ) : (
        <Unavailable retry={retry} />
      )}
    </div>
  )
}
