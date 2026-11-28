import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { TaskPageData } from '@/store/slices/ui/ui-slice-contract-core'
import type { HttpLinkAction } from '@/lib/browser/navigation/http-link-destinations'
import { beginLinkOpenRequest, subscribeLinkOpenRequests } from '@/lib/links/link-open-request'
import { isTwinRepo } from '@/lib/workspace/ownership/repo-runtime-owner'
import {
  repoRouteIdentity,
  resolveWorktreeOwnerRepo,
  type WorktreeOwnerRepoState
} from '@/lib/workspace/ownership/worktree-owner-repo'
import { getTaskPageRepoSourceContext } from '../task-repo-source-context'
import { lookupGitHubWorkItemByOwnerRepoForSource } from './github-work-item-source-lookup'
import {
  parseGitHubIssueOrPRLink,
  type GitHubIssueOrPRLink
} from '../../../../../shared/github/repositories/links'
import { isDefaultGitHubHost } from '../../../../../shared/github/repositories/repository-identity-key'
import { splitGitRemoteKey } from '../../../../../shared/git/remotes/git-remote-identity'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'

/** Matches the environment RPC's bound; it only ever fails the open. */
const GITHUB_LINK_OPEN_TIMEOUT_MS = 30_000

type GitHubLinkTaskTab = NonNullable<TaskPageData['openGitHubInitialTab']>

type GitHubLinkTaskTarget = { link: GitHubIssueOrPRLink; initialTab: GitHubLinkTaskTab }

let taskPageLinkActionsDisabled = false

/** For windows without a Tasks page (the dashboard pop-out): links there never offer the row. */
export function disableTaskPageLinkActions(): void {
  taskPageLinkActionsDisabled = true
}

function githubLinkTaskTarget(url: string): GitHubLinkTaskTarget | null {
  const link = parseGitHubIssueOrPRLink(url)
  if (!link) {
    return null
  }
  // Only the exact www host folds; GHES hosts and ports keep their identity.
  const host = link.slug.host === 'www.github.com' ? 'github.com' : link.slug.host
  return {
    link: { ...link, slug: { ...link.slug, host } },
    initialTab: link.type === 'pr' ? pullRequestTab(url) : 'conversation'
  }
}

function pullRequestTab(url: string): GitHubLinkTaskTab {
  const tab = new URL(url.trim()).pathname.split('/').filter(Boolean)[4]?.toLowerCase()
  return tab === 'files' || tab === 'changes'
    ? 'files'
    : tab === 'checks'
      ? 'checks'
      : 'conversation'
}

/** The unique git row owning the clicked worktree on its host. Twins are refused here: the resolver
 * still answers for an active or host-stamped worktree whose repo id is on two hosts. */
function readLinkSourceProject(state: WorktreeOwnerRepoState, worktreeId: string): Repo | null {
  const row = resolveWorktreeOwnerRepo(state, worktreeId)
  return row && !isTwinRepo(state, row.id) ? row : null
}

/** github.com, or a host the row itself names; other forges' `/issues/N` links get no row. */
function linkHostNamedByRow(host: string | undefined, row: Repo): boolean {
  if (isDefaultGitHubHost(host)) {
    return true
  }
  const linkHost = host?.toLowerCase()
  return [
    row.ghAccount?.host,
    row.upstream?.host,
    splitGitRemoteKey(row.gitRemoteIdentity?.canonicalKey, (value) => value)?.host
  ].some((rowHost) => rowHost?.toLowerCase() === linkHost)
}

function sourceFingerprint(row: Repo): string {
  return JSON.stringify([repoRouteIdentity(row), getTaskPageRepoSourceContext(row, 'github')])
}

/** Store-only, no IPC: main decides membership when the row is clicked. */
export function githubLinkOpenInOrcaAction(
  worktreeId: string,
  url: string | undefined,
  t: Translate = translate,
  onTaskPageOpen?: () => void
): HttpLinkAction | null {
  const target = !taskPageLinkActionsDisabled && url ? githubLinkTaskTarget(url) : null
  const row = target ? readLinkSourceProject(useAppStore.getState(), worktreeId) : null
  if (!target || !row || !linkHostNamedByRow(target.link.slug.host, row)) {
    return null
  }
  return {
    icon: 'open-in-orca',
    label:
      target.link.type === 'pr'
        ? t('components.link.openInOrca.pullRequest', 'Open PR in Orca')
        : t('components.link.openInOrca.issue', 'Open issue in Orca'),
    run: () => openGitHubLinkInOrca(target, worktreeId, t, onTaskPageOpen)
  }
}

function githubLinkTaskPageData(
  repo: Repo,
  item: GitHubWorkItem,
  sourceContext: TaskSourceContext | null,
  initialTab: GitHubLinkTaskTab
): TaskPageData {
  return {
    taskSource: 'github',
    preselectedRepoId: repo.id,
    openGitHubWorkItem: { ...item, repoId: repo.id, repoHostId: getRepoExecutionHostId(repo) },
    openGitHubSourceContext: sourceContext,
    openGitHubInitialTab: initialTab
  }
}

async function openGitHubLinkInOrca(
  target: GitHubLinkTaskTarget,
  worktreeId: string,
  t: Translate,
  onTaskPageOpen?: () => void
): Promise<void> {
  const isCurrent = beginLinkOpenRequest()
  const { link, initialTab } = target
  const values = { number: link.number }
  const toastId = toast.loading(
    link.type === 'pr'
      ? t('components.link.openInOrca.openingPullRequest', 'Opening PR #{{number}}…', values)
      : t('components.link.openInOrca.openingIssue', 'Opening issue #{{number}}…', values)
  )
  const fail = (): void => {
    toast.error(
      link.type === 'pr'
        ? t(
            'components.link.openInOrca.pullRequestFailed',
            "Couldn't open PR #{{number}} in Orca.",
            values
          )
        : t(
            'components.link.openInOrca.issueFailed',
            "Couldn't open issue #{{number}} in Orca.",
            values
          ),
      { id: toastId }
    )
  }
  const source = readLinkSourceProject(useAppStore.getState(), worktreeId)
  if (!source) {
    fail()
    return
  }
  const fingerprint = sourceFingerprint(source)
  const sourceContext = getTaskPageRepoSourceContext(source, 'github')
  const sourceUnchanged = (): boolean => {
    const current = readLinkSourceProject(useAppStore.getState(), worktreeId)
    return !!current && sourceFingerprint(current) === fingerprint
  }
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve(null)
    }, GITHUB_LINK_OPEN_TIMEOUT_MS)
  })
  // A newer link open takes over at once, so this open's toast goes with it.
  const stopOnSupersede = subscribeLinkOpenRequests(() => toast.dismiss(toastId))
  let item: GitHubWorkItem | null = null
  try {
    // Main checks membership against this row's remotes but caches SSH/WSL remote identity and the
    // GHES origin for up to 30 s, so just after a remote switch this can open the old repo's item or
    // refuse the new one.
    item = await Promise.race([
      lookupGitHubWorkItemByOwnerRepoForSource({
        repoPath: source.path,
        repoId: source.id,
        sourceContext,
        owner: link.slug.owner,
        repo: link.slug.repo,
        ...(link.slug.host ? { host: link.slug.host } : {}),
        number: link.number,
        type: link.type,
        // Drops a superseded, timed-out or rebound read before it is sent and when it answers.
        accepts: () => isCurrent() && !timedOut && sourceUnchanged()
      }),
      watchdog
    ])
  } catch {
    item = null
  } finally {
    clearTimeout(timer)
    stopOnSupersede()
  }
  if (!isCurrent()) {
    return
  }
  if (!item || !sourceUnchanged()) {
    fail()
    return
  }
  toast.dismiss(toastId)
  useAppStore
    .getState()
    .openTaskPage(githubLinkTaskPageData(source, item, sourceContext, initialTab))
  onTaskPageOpen?.()
}
