import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { TaskPageData } from '@/store/slices/ui/ui-slice-contract-core'
import type { HttpLinkAction } from '@/lib/browser/navigation/http-link-destinations'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
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

/** Bounds a local lookup the way the environment RPC already is; it only ever fails the open. */
export const GITHUB_LINK_OPEN_TIMEOUT_MS = 30_000

type GitHubLinkTaskTab = NonNullable<TaskPageData['openGitHubInitialTab']>

export type GitHubLinkTaskTarget = { link: GitHubIssueOrPRLink; initialTab: GitHubLinkTaskTab }

let taskPageLinkActionsDisabled = false

/** For windows without a Tasks page (the dashboard pop-out): links there never offer the row. */
export function disableTaskPageLinkActions(): void {
  taskPageLinkActionsDisabled = true
}

export function githubLinkTaskTarget(url: string): GitHubLinkTaskTarget | null {
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

/** The clicked surface's own project: the unique git row owning that worktree on its host. */
export function readLinkSourceProject(
  state: WorktreeOwnerRepoState,
  worktreeId: string
): Repo | null {
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

/** Synchronous and IPC-free: membership is decided by main only when the row is clicked. */
export function githubLinkOpenInOrcaAction(
  worktreeId: string,
  url: string | undefined,
  t: Translate = translate
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
    run: () => openGitHubLinkInOrca(target, worktreeId, t)
  }
}

export function githubLinkTaskPageData(
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

export async function openGitHubLinkInOrca(
  target: GitHubLinkTaskTarget,
  worktreeId: string,
  t: Translate = translate
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
  let item: GitHubWorkItem | null = null
  try {
    // Main decides membership from this row's own remotes at request time. Its SSH/WSL remote
    // identity (and GHES origin) is cached for up to 30 s, so right after an in-place remote switch
    // this can still open the old repo's item or refuse the new one; accepted as bounded staleness.
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
        // Also keeps a superseded or rebound read from publishing into the shared task records.
        accepts: () => isCurrent() && !timedOut && sourceUnchanged()
      }),
      watchdog
    ])
  } catch {
    item = null
  } finally {
    clearTimeout(timer)
  }
  if (!isCurrent()) {
    toast.dismiss(toastId)
    return
  }
  if (!item || timedOut || !sourceUnchanged()) {
    fail()
    return
  }
  toast.dismiss(toastId)
  useAppStore
    .getState()
    .openTaskPage(githubLinkTaskPageData(source, item, sourceContext, initialTab))
}
