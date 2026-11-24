import {
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { GitHubUserAvatar } from '@/components/github/github-user-avatar'
import { WorkItemStateBadge } from '@/components/github/work-item-state-badge'
import { formatRelativeTime } from '@/components/github/work-item-state-presentation'
import { DiffLineCounts } from '@/components/right-sidebar/source-control/listing/diff-line-counts'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  parseGitHubIssueOrPRLink,
  type GitHubIssueOrPRLink
} from '../../../../../../shared/github/repositories/links'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { HostAuthorityKey } from '../../../../../../shared/execution-host/host-authority'
import {
  githubLinkPreviewKey,
  loadGitHubLinkPreview,
  loadRoutedGitHubLinkPreview,
  readCachedGitHubLinkPreview,
  readCachedRoutedGitHubLinkPreview,
  routedGitHubLinkPreviewKey
} from './native-chat-github-link-preview'
import {
  githubLinkBelongsToRepo,
  githubLinkOnRepoHost,
  type NativeChatGitHubRepo
} from './native-chat-github-repo'
import type { NativeChatLinkPeek as NativeChatLinkPeekValue } from './native-chat-link-peek-context'
import { useNativeChatHoverPreview } from './use-native-chat-hover-preview'
import { LinkPeekRetryContext } from './link-peek-retry-context'
import {
  createGitHubPreviewRouteStore,
  type GitHubPreviewRouteStore
} from './native-chat-github-route-store'

const subscribeNothing = (): (() => void) => () => {}
const readNoRepo = (): null => null

function PeekFooter({ item }: { item: GitHubWorkItem }): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
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
          {t('components.native-chat.githubPeek.updated', 'updated {{time}}', {
            time: formatRelativeTime(item.updatedAt, intlLocale)
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
              ? t('components.native-chat.githubPeek.oneComment', '1 comment')
              : t('components.native-chat.githubPeek.comments', '{{count}} comments', {
                  count: item.commentCount
                })}
          </span>
        </>
      ) : null}
    </div>
  )
}

/** Which lookup answers a card: the chat repo's, or one routed through another repo on the chat's host. */
export type GitHubPeekSource =
  | { kind: 'repo'; repo: Repo }
  | { kind: 'routed'; authorityKey: HostAuthorityKey }

function peekLookup(
  source: GitHubPeekSource,
  link: GitHubIssueOrPRLink,
  key: string,
  route: GitHubPreviewRouteStore | null
) {
  return source.kind === 'repo'
    ? {
        key,
        read: () => readCachedGitHubLinkPreview(source.repo, link),
        load: () => loadGitHubLinkPreview(source.repo, link)
      }
    : {
        key,
        read: () =>
          readCachedRoutedGitHubLinkPreview(source.authorityKey, link, route ?? undefined),
        load: () => loadRoutedGitHubLinkPreview(source.authorityKey, link, route ?? undefined)
      }
}

export function NativeChatGitHubPeekBody({
  source,
  link,
  otherRepoFallback,
  failedFallback
}: {
  source: GitHubPeekSource
  link: GitHubIssueOrPRLink
  /** Shown above the failure line when the lookup fails, in place of `otherRepoFallback`: what the
   *  caller still knows for sure (its title), never a state the failure leaves unconfirmed. */
  failedFallback?: ReactNode
  /** For a link to another repo, which an older host or a repo the sign-in can't read leaves
   *  unanswered: what such a link showed before, kept until its details arrive, and never a failure.
   *  Null shows just the name until then. Undefined for the chat repo's own links. */
  otherRepoFallback?: ReactNode
}): ReactNode {
  // Select the catalog itself so unrelated store updates don't rescan it for a route.
  const routeRepos = useAppStore((state) => (source.kind === 'routed' ? state.repos : null))
  const route = useMemo(
    () =>
      source.kind === 'routed'
        ? createGitHubPreviewRouteStore(routeRepos ?? [], source.authorityKey, link)
        : null,
    [source, link, routeRepos]
  )
  const routedRepo = useSyncExternalStore(
    route?.subscribe ?? subscribeNothing,
    route?.read ?? readNoRepo
  )
  const key = useMemo(
    () =>
      source.kind === 'repo'
        ? githubLinkPreviewKey(source.repo, link)
        : routedGitHubLinkPreviewKey(source.authorityKey, link, routedRepo),
    [source, link, routedRepo]
  )
  return (
    <GitHubPeekContent
      key={key}
      lookup={peekLookup(source, link, key, route)}
      link={link}
      otherRepoFallback={otherRepoFallback}
      failedFallback={failedFallback}
    />
  )
}

function GitHubPeekContent({
  lookup,
  link,
  otherRepoFallback,
  failedFallback
}: {
  lookup: ReturnType<typeof peekLookup>
  link: GitHubIssueOrPRLink
  otherRepoFallback?: ReactNode
  failedFallback?: ReactNode
}): ReactNode {
  const t = useTranslate()
  const { state, retry } = useNativeChatHoverPreview(lookup.key, lookup.read, lookup.load)
  const retryKey = useContext(LinkPeekRetryContext)
  // A retry keeps the failed card's layout until it answers: the card must not shrink or lose its
  // focused Retry from under the pointer or the key that asked, or another link's card takes over.
  const [retrying, setRetrying] = useState(false)
  if (retrying && state.status !== 'loading') {
    setRetrying(false)
  }
  const pendingRetry = retrying && state.status === 'loading'
  const startRetry = () => {
    setRetrying(true)
    retry()
  }
  const reportRetry = useEffectEvent((status: typeof state.status, pending: boolean) =>
    retryKey?.report(
      status === 'failed'
        ? { status: 'failed', retry: startRetry }
        : pending
          ? { status: 'retrying' }
          : { status: 'idle' }
    )
  )
  useEffect(() => {
    reportRetry(state.status, pendingRetry)
  }, [state.status, pendingRetry])
  useEffect(() => () => reportRetry('ready', false), [])
  const failed = (state.status === 'failed' || pendingRetry) && failedFallback !== undefined
  if (otherRepoFallback && state.status !== 'ready' && !failed) {
    return otherRepoFallback
  }
  const unavailable = (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{t('components.native-chat.githubPeek.unavailable', 'Preview unavailable.')}</span>
      {/* Still focusable while the retry runs, so focus stays put; a second press does nothing. */}
      <Button
        variant={pendingRetry ? 'link-muted' : 'link'}
        size="xs"
        aria-disabled={pendingRetry || undefined}
        aria-busy={pendingRetry || undefined}
        onClick={pendingRetry ? undefined : startRetry}
      >
        {t('components.native-chat.githubPeek.retry', 'Retry')}
      </Button>
      {/* The link announces the key with the failure; this shows it. */}
      {retryKey ? (
        <kbd
          aria-hidden
          className="rounded border border-border px-1 font-mono text-3xs text-muted-foreground"
        >
          {retryKey.key.toUpperCase()}
        </kbd>
      ) : null}
    </div>
  )
  return (
    <div className="flex flex-col gap-1.5">
      {/* Known from the URL, so the card has a header before the lookup answers. Rows wrap rather
          than clip in a window too narrow for the card's usual width. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <GitHubIcon className="size-3.5 shrink-0" aria-hidden />
        {/* Cut to fit, whole on hover. */}
        <span className="min-w-0 truncate" title={`${link.slug.owner}/${link.slug.repo}`}>
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
                  title={label}
                  className="max-w-full truncate rounded-full border border-border px-1.5 text-3xs text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          <PeekFooter item={state.value} />
        </>
      ) : failed ? (
        <>
          {failedFallback}
          {unavailable}
        </>
      ) : otherRepoFallback !== undefined ? null : state.status === 'loading' && !pendingRetry ? (
        <div aria-hidden className="flex flex-col gap-1.5 motion-safe:animate-pulse">
          <div className="h-3.5 w-11/12 rounded bg-muted" />
          <div className="h-3.5 w-1/2 rounded bg-muted" />
          <div className="mt-0.5 h-3 w-1/3 rounded bg-muted" />
        </div>
      ) : (
        unavailable
      )}
    </div>
  )
}

/** Whether `NativeChatLinkPeek` shows a GitHub card for `href` under this context: the same test it runs,
 *  for a caller that must drop its own tooltip when the card shows. */
export function hasGitHubLinkPeek(
  { githubRepo, githubRoutingAuthorityKey }: NativeChatLinkPeekValue,
  href: string
): boolean {
  if (resolveGitHubPeekLink(githubRepo, href)) {
    return true
  }
  return githubRoutingAuthorityKey !== null && parseGitHubIssueOrPRLink(href) !== null
}

/** A PR or issue link on a host the chat's GitHub repo uses, and whether it is that repo's own; null
 *  when the link isn't one. */
export function resolveGitHubPeekLink(
  githubRepo: NativeChatGitHubRepo | null,
  href: string
): { link: GitHubIssueOrPRLink; ownRepo: boolean } | null {
  const link = githubRepo ? parseGitHubIssueOrPRLink(href) : null
  return githubRepo && link && githubLinkOnRepoHost(githubRepo, link.slug)
    ? { link, ownRepo: githubLinkBelongsToRepo(githubRepo, link.slug) }
    : null
}
