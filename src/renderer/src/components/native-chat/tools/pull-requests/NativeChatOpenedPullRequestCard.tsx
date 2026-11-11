import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState
} from 'react'
import { GitPullRequest } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { getReviewStateIcon } from '@/components/github/review-state-presentation'
import { DiffLineCounts } from '@/components/right-sidebar/source-control/listing/diff-line-counts'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/links'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'
import {
  nativeChatOpenedPullRequestKey,
  type NativeChatOpenedPullRequest
} from '../../../../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { NATIVE_CHAT_OPENED_PULL_REQUESTS_SETTING_SECTION_ID } from '../../../settings/chat/native-chat-opened-pull-requests-setting-target'
import {
  NativeChatCardHideButton,
  NATIVE_CHAT_HIDEABLE_CARD_CLASS
} from '../../messages/disclosure/NativeChatCardHideButton'
import {
  githubLinkPreviewKey,
  loadGitHubLinkPreview,
  readCachedGitHubLinkPreview,
  reloadGitHubLinkPreview
} from '../../links/previews/native-chat-github-link-preview'
import {
  githubLinkBelongsToRepo,
  type NativeChatGitHubRepo
} from '../../links/previews/native-chat-github-repo'
import { NativeChatLinkPeekContext } from '../../links/previews/native-chat-link-peek-context'
import { NativeChatMarkdownImageOwnerContext } from '../../media/images/native-chat-markdown-image-owner'
import { useNativeChatLinkClick } from '../../links/actions/native-chat-link-click-context'

/** The chat's newest finished command that may have changed a pull request; cards reread on it. */
export const NativeChatPullRequestChangeContext = createContext<string | undefined>(undefined)

// An open pull request rereads this often while its card is on screen; merged or closed ones stop.
const OPEN_PULL_REQUEST_REFRESH_MS = 60_000
const MAX_REFRESH_MS = 15 * 60_000

const STATE_TEXT_TONE: Record<GitHubWorkItem['state'], string> = {
  open: 'text-emerald-600 dark:text-emerald-300',
  draft: 'text-chat-foreground-faint',
  merged: 'text-purple-600 dark:text-purple-300',
  closed: 'text-rose-600 dark:text-rose-300'
}

/** `orca#3`, or `owner/other#5` for another repo than the chat's own, which the card can't read. */
function pullRequestName(
  pullRequest: NativeChatOpenedPullRequest,
  githubRepo: NativeChatGitHubRepo | null
): string {
  if (pullRequest.provider !== 'github') {
    return `${pullRequest.slug.path.split('/').at(-1)}!${pullRequest.number}`
  }
  const { owner, repo } = pullRequest.slug
  return githubRepo && !githubLinkBelongsToRepo(githubRepo, pullRequest.slug)
    ? `${owner}/${repo}#${pullRequest.number}`
    : `${repo}#${pullRequest.number}`
}

function previewLink(
  githubRepo: NativeChatGitHubRepo | null,
  pullRequest: NativeChatOpenedPullRequest
): { repo: NativeChatGitHubRepo['repo']; link: GitHubIssueOrPRLink } | null {
  // Main answers only for the chat's own remotes; another repo's pull request keeps its name alone.
  return githubRepo &&
    pullRequest.provider === 'github' &&
    githubLinkBelongsToRepo(githubRepo, pullRequest.slug)
    ? {
        repo: githubRepo.repo,
        link: { slug: pullRequest.slug, number: pullRequest.number, type: 'pr' }
      }
    : null
}

type HeldDetails = {
  key: string | null
  item: GitHubWorkItem | null
  settled: boolean
  /** Reads in a row that answered nothing, which stretch the reread interval. */
  failures: number
}

/** Title, counts and state read from the pull request; a failed reread keeps the last answer. */
function usePullRequestDetails(target: ReturnType<typeof previewLink>): {
  item: GitHubWorkItem | null
  settled: boolean
} {
  const changeKey = useContext(NativeChatPullRequestChangeContext)
  // A chat in a hidden tab stays mounted; it rereads when shown again, not while hidden.
  const chatVisible = useContext(NativeChatMarkdownImageOwnerContext)?.isVisible ?? true
  const key = target ? githubLinkPreviewKey(target.repo, target.link) : null
  const [held, setHeld] = useState<HeldDetails>(() => {
    const item = target ? readCachedGitHubLinkPreview(target.repo, target.link) : null
    return { key, item, settled: item !== null || target === null, failures: 0 }
  })
  const current: HeldDetails =
    held.key === key ? held : { key, item: null, settled: target === null, failures: 0 }
  const [tick, setTick] = useState(0)
  const readKey = useRef<string | null>(null)
  const read = useEffectEvent((onSettled: (item: GitHubWorkItem | null) => void) => {
    if (!target) {
      return
    }
    // The first read may use a fresh cached answer; later ones follow a change and must ask again.
    const fresh = readKey.current !== key
    readKey.current = key
    void (fresh ? loadGitHubLinkPreview : reloadGitHubLinkPreview)(target.repo, target.link).then(
      onSettled,
      () => onSettled(null)
    )
  })
  useEffect(() => {
    if (!chatVisible) {
      return
    }
    let cancelled = false
    read((item) => {
      if (!cancelled) {
        // A failed reread keeps the last answer rather than blanking a card that had one.
        setHeld((last) => {
          const previous = last.key === key ? last : null
          return {
            key,
            item: item ?? previous?.item ?? null,
            settled: true,
            failures: item ? 0 : (previous?.failures ?? 0) + 1
          }
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [key, changeKey, tick, chatVisible])
  const settledState = current.item?.state
  const polls =
    chatVisible && key !== null && settledState !== 'merged' && settledState !== 'closed'
  // A lookup that keeps failing (signed out, another host) backs off instead of asking every minute.
  const delay = Math.min(OPEN_PULL_REQUEST_REFRESH_MS * 2 ** current.failures, MAX_REFRESH_MS)
  useEffect(() => {
    if (!polls) {
      return
    }
    // A window in the background waits to be shown before it asks.
    const reread = (): void => {
      if (document.visibilityState === 'visible') {
        setTick((value) => value + 1)
      } else {
        document.addEventListener('visibilitychange', reread, { once: true })
      }
    }
    const timer = window.setTimeout(reread, delay)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', reread)
    }
  }, [polls, delay, tick])
  return { item: current.item, settled: current.settled }
}

function OpenedPullRequestRow({
  pullRequest
}: {
  pullRequest: NativeChatOpenedPullRequest
}): React.JSX.Element {
  const { githubRepo } = useContext(NativeChatLinkPeekContext)
  const onLinkClick = useNativeChatLinkClick()
  const target = previewLink(githubRepo, pullRequest)
  const { item, settled } = usePullRequestDetails(target)
  return (
    <a
      href={pullRequest.url}
      onClick={(event) => {
        if (onLinkClick) {
          onLinkClick(event, pullRequest.url)
        }
      }}
      className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-chat-foreground no-underline hover:bg-chat-code-surface"
    >
      {createElement((item && getReviewStateIcon(item.state)) || GitPullRequest, {
        'aria-hidden': true,
        className: cn(
          'size-3.5 shrink-0',
          item ? STATE_TEXT_TONE[item.state] : 'text-chat-foreground-faint'
        )
      })}
      <span className="shrink-0 text-chat-foreground-faint">
        {pullRequestName(pullRequest, githubRepo)}
      </span>
      {item ? (
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
      ) : (
        // Holds the title's place so nothing moves when it arrives.
        <span className="min-w-0 flex-1">
          {settled ? null : (
            <span aria-hidden className="block h-3 w-40 max-w-full rounded bg-chat-code-surface" />
          )}
        </span>
      )}
      {item ? <DiffLineCounts added={item.additions} removed={item.deletions} size="sm" /> : null}
    </a>
  )
}

/** "Opened orca#3": the pull requests a turn's own commands opened, each opening on click. */
export function NativeChatOpenedPullRequestCard({
  pullRequests
}: {
  pullRequests: readonly NativeChatOpenedPullRequest[]
}): React.JSX.Element {
  const t = useTranslate()
  const [first] = pullRequests
  const { githubRepo } = useContext(NativeChatLinkPeekContext)
  return (
    <div
      className={`${NATIVE_CHAT_HIDEABLE_CARD_CLASS} rounded-lg border border-chat-code-border p-2 text-sm`}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1 text-xs text-chat-foreground-faint">
        <span className="min-w-0 truncate">
          {pullRequests.length === 1 && first
            ? t('components.native-chat.openedPullRequests.one', 'Opened {{name}}', {
                name: pullRequestName(first, githubRepo)
              })
            : t(
                'components.native-chat.openedPullRequests.many',
                'Opened {{count}} pull requests',
                { count: pullRequests.length, defaultValue_one: 'Opened {{count}} pull request' }
              )}
        </span>
        <NativeChatCardHideButton
          ariaLabel={t(
            'components.native-chat.openedPullRequests.hide',
            "Don't show opened pull requests"
          )}
          updates={{ nativeChatOpenedPullRequests: false }}
          settingSectionId={NATIVE_CHAT_OPENED_PULL_REQUESTS_SETTING_SECTION_ID}
          hiddenMessage={t(
            'components.native-chat.openedPullRequests.hidden',
            "Orca won't show opened pull requests anymore"
          )}
        />
      </div>
      <div className="space-y-0.5">
        {pullRequests.map((pullRequest) => (
          <OpenedPullRequestRow
            key={nativeChatOpenedPullRequestKey(pullRequest)}
            pullRequest={pullRequest}
          />
        ))}
      </div>
    </div>
  )
}
