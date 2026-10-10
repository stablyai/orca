import type { Repo } from '../../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { branchName } from '@/lib/git-utils'
import { resolveTerminalNotificationOwner } from '@/attention/notification-subject-owner'
import { getWorkspaceAttachmentTerminalOrigin } from '@/lib/workspace-attachment-terminal-origin'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachment-normalization'
import {
  getWorkspaceAttachmentOriginKey,
  mergeWorkspaceAttachmentOrigins
} from '../../../../../../shared/workspace-attachment-origins'
import { isGitHubPRSuppressed } from '../../../../../../shared/worktree/github-pr-suppression'
import type { WorkspaceAttachment, Worktree } from '../../../../../../shared/worktree/types'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { findRepoForHost } from '../../repo-host-identity'
import { readHostedReviewForRepo } from '@/lib/hosted-review-repo-read'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/github-work-item-source-lookup'
import { buildTaskSourceContextFromRepo } from '../../../../../../shared/task-source-context'
import { PrioritySemaphore } from '../../../../../../shared/priority-semaphore'

function terminalReviewSourceKey(repo: Repo | null | undefined): string {
  const host = repo && parseExecutionHostId(getRepoExecutionHostId(repo))
  return JSON.stringify([
    repo?.id,
    repo?.path,
    host?.id,
    repo?.connectionId,
    repo?.gitRemoteIdentity?.canonicalKey,
    repo?.ghAccount,
    getProviderRuntimeContextKey(null),
    host?.kind === 'runtime' ? getRuntimeEnvironmentRevision(host.environmentId) : null
  ])
}

export function createObserveTerminalGitHubPullRequestLink(
  get: WorktreeSliceGet
): WorktreeSlice['observeTerminalGitHubPullRequestLink'] {
  const pending = new Set<string>()
  const confirmations = new PrioritySemaphore(3)
  return (worktreeId, link, context) => {
    const state = get()
    const owner = context ? resolveTerminalNotificationOwner(state, worktreeId, context) : null
    const hostId = owner?.executionHostId ?? undefined
    if (context && (!hostId || (context.executionHostId && context.executionHostId !== hostId))) {
      return
    }
    const worktree = findKnownWorktreeById(state, worktreeId, hostId)
    if (
      !worktree ||
      worktree.isBare ||
      worktree.isArchived ||
      isGitHubPRSuppressed(worktree, link.number)
    ) {
      return
    }
    const repo = findRepoForHost(state.repos, worktree.repoId, {
      hostId: hostId ?? worktree.hostId,
      settings: state.settings
    })
    if (!repo || (repo.kind && repo.kind !== 'git')) {
      return
    }
    const sourceKey = terminalReviewSourceKey(repo)
    const originalBranch = worktree.branch
    const branch = branchName(originalBranch)
    const head = worktree.head
    const identityKey = worktree.identity?.key
    const pushBranch = worktree.pushTarget?.branchName
    let confirmedPushBranch: string | undefined
    const origin = context
      ? getWorkspaceAttachmentTerminalOrigin(state, worktreeId, context, hostId)
      : undefined
    if (context && !origin) {
      return
    }
    const contextIsCurrent = (): boolean => {
      if (!context) {
        return true
      }
      const latest = get()
      const latestOwner = resolveTerminalNotificationOwner(latest, worktreeId, context)
      const latestOrigin = getWorkspaceAttachmentTerminalOrigin(latest, worktreeId, context, hostId)
      return (
        latestOwner?.executionHostId === hostId &&
        Boolean(
          latestOrigin &&
          origin &&
          getWorkspaceAttachmentOriginKey(latestOrigin) === getWorkspaceAttachmentOriginKey(origin)
        )
      )
    }
    const linked = getWorkspaceAttachments(worktree).find(
      (item) =>
        item.provider === 'github' &&
        item.type === 'pr' &&
        item.number === link.number &&
        (!item.url || item.url === link.url)
    )
    const wasLinked = Boolean(linked)
    const requestKey = JSON.stringify([
      hostId,
      worktreeId,
      link.url,
      sourceKey,
      identityKey,
      head,
      originalBranch,
      origin && getWorkspaceAttachmentOriginKey(origin)
    ])
    if (pending.has(requestKey)) {
      return
    }
    const stillEligible = (current: Worktree | undefined): boolean =>
      Boolean(
        current &&
        contextIsCurrent() &&
        !current.isArchived &&
        !current.isBare &&
        current.identity?.key === identityKey &&
        current.head === head &&
        terminalReviewSourceKey(
          findRepoForHost(get().repos, current.repoId, {
            hostId: hostId ?? current.hostId,
            settings: get().settings
          })
        ) === sourceKey &&
        current.branch === originalBranch &&
        (!confirmedPushBranch || current.pushTarget?.branchName === confirmedPushBranch) &&
        !isGitHubPRSuppressed(current, link.number)
      )
    const observationIsCurrent = (): boolean =>
      stillEligible(findKnownWorktreeById(get(), worktreeId, hostId))
    const persist = async (): Promise<void> => {
      const current = findKnownWorktreeById(get(), worktreeId, hostId)
      if (!stillEligible(current)) {
        return
      }
      const items = getWorkspaceAttachments(current)
      const prior = items.find(
        (item) =>
          item.provider === 'github' &&
          item.type === 'pr' &&
          item.number === link.number &&
          (!item.url || item.url === link.url)
      )
      if (wasLinked && !prior) {
        return
      }
      if (!origin && prior) {
        return
      }
      const attachment: WorkspaceAttachment = {
        ...(prior ?? { provider: 'github', type: 'pr', number: link.number }),
        ...(origin
          ? { url: link.url, origins: mergeWorkspaceAttachmentOrigins(prior?.origins, [origin]) }
          : {})
      }
      if (prior && JSON.stringify(prior) === JSON.stringify(attachment)) {
        return
      }
      const linkedItems = prior
        ? items.map((item) =>
            getWorkspaceAttachmentKey(item) === getWorkspaceAttachmentKey(prior) ? attachment : item
          )
        : [...items, attachment]
      await get().updateWorktreeMeta(
        worktreeId,
        { linkedItems },
        { executionHostId: hostId, shouldApply: stillEligible }
      )
    }
    if (linked?.url === link.url && origin) {
      pending.add(requestKey)
      void persist()
        .catch((error) => console.warn('Could not record reference terminal', error))
        .finally(() => pending.delete(requestKey))
      return
    }
    pending.add(requestKey)
    const confirm = async (): Promise<boolean> => {
      if (!wasLinked) {
        const exact = await lookupGitHubWorkItemByOwnerRepoForSource({
          repoPath: repo.path,
          repoId: repo.id,
          sourceContext: buildTaskSourceContextFromRepo({
            provider: 'github',
            projectId: repo.id,
            repo
          }),
          owner: link.slug.owner,
          repo: link.slug.repo,
          host: new URL(link.url).hostname,
          number: link.number,
          type: 'pr'
        }).catch(() => null)
        if (!observationIsCurrent()) {
          return false
        }
        if (exact) {
          const headBranch = exact.branchName?.trim()
          const headMatches = headBranch === branch || headBranch === pushBranch
          if (
            exact.type !== 'pr' ||
            exact.number !== link.number ||
            exact.url !== link.url ||
            (headBranch && !headMatches) ||
            (exact.headSha && exact.headSha !== head)
          ) {
            return false
          }
          if (headBranch && exact.headSha && head) {
            confirmedPushBranch = headBranch === branch ? undefined : headBranch
            return true
          }
        }
      }
      // Older hosts may omit exact head evidence; retain their branch-confirmation path.
      const pr = await readHostedReviewForRepo(repo, {
        branch,
        force: true,
        active: true,
        currentHeadOid: head,
        linkedGitHubPR: wasLinked ? link.number : null,
        linkedGitLabMR: null,
        linkedBitbucketPR: null,
        linkedAzureDevOpsPR: null,
        linkedGiteaPR: null
      })
      return (
        observationIsCurrent() &&
        pr?.provider === 'github' &&
        pr.number === link.number &&
        pr.url === link.url
      )
    }
    const confirmWhenAdmitted = async (): Promise<void> => {
      if (!observationIsCurrent()) {
        return
      }
      const release = await confirmations.acquire(0)
      try {
        if (observationIsCurrent() && (await confirm())) {
          await persist()
        }
      } finally {
        // Native reads keep their permit until settlement, even if their pane disappears.
        release()
      }
    }
    void confirmWhenAdmitted()
      .catch((error) => console.warn('Could not confirm terminal reference', error))
      .finally(() => pending.delete(requestKey))
  }
}
