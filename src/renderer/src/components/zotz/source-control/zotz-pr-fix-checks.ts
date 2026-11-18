import { useAppStore } from '@/store/index'
import { sendMessageToAgent } from '@/lib/agent-session/messaging/agent-message-send'
import {
  deriveRunningAgentSendTargets,
  runningAgentMessageTarget,
  type RunningAgentSendTarget
} from '@/lib/agent-session/messaging/running-agent-targets'
import { startFixChecksAgent } from '@/lib/source-control/checks/fix-checks-agent-launch'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  buildFixBrokenChecksPrompt,
  collectFixChecksPromptDetails,
  getBrokenChecks,
  hasGitHubCheckHandle
} from '../../../../../shared/source-control/checks/pr-checks-fix-prompt'

export type ZotzFixChecksOutcome = 'sent' | 'launched' | 'nothing-broken' | 'agent-busy' | 'failed'

/** The conversation's agent: the one in the active tab, else the first that can take a message. */
export function pickZotzFixChecksTarget(
  targets: readonly RunningAgentSendTarget[],
  activeTabId: string | null
): RunningAgentSendTarget | null {
  const eligible = targets.filter((target) => target.status === 'eligible')
  return eligible.find((target) => target.tabId === activeTabId) ?? eligible[0] ?? null
}

/** The broken checks with their failed-step logs, worded like upstream's "Fix With AI". */
async function buildPrompt(
  repo: Repo,
  review: HostedReviewInfo,
  checks: PRCheckDetail[]
): Promise<string> {
  const { fetchPRCheckDetails } = useAppStore.getState()
  const prRepo = review.githubRepository
    ? { owner: review.githubRepository.owner, repo: review.githubRepository.repo }
    : null
  const details = await collectFixChecksPromptDetails(checks, (check) =>
    hasGitHubCheckHandle(check)
      ? fetchPRCheckDetails(
          repo.path,
          {
            checkRunId: check.checkRunId,
            workflowRunId: check.workflowRunId,
            checkName: check.name,
            url: check.url,
            prRepo
          },
          { repoId: repo.id, repoOwnerExecutionHostId: getRepoExecutionHostId(repo) }
        )
      : Promise.resolve(null)
  )
  return buildFixBrokenChecksPrompt({
    reviewKind: review.provider === 'gitlab' ? 'MR' : 'PR',
    reviewNumber: review.number,
    reviewTitle: review.title,
    reviewUrl: review.url,
    checks,
    checkRunDetailsByCheckKey: details
  })
}

/**
 * "Fix errors": the broken checks go to this conversation's own agent. With no agent running,
 * it falls back to upstream's new fix-checks tab. `onlyIfIdle` (autofix) never opens a new
 * tab and never interrupts a busy agent.
 */
export async function fixZotzPrChecks(input: {
  worktreeId: string
  repo: Repo
  review: HostedReviewInfo
  checks: PRCheckDetail[]
  onlyIfIdle?: boolean
}): Promise<ZotzFixChecksOutcome> {
  if (getBrokenChecks(input.checks).length === 0) {
    return 'nothing-broken'
  }
  const state = useAppStore.getState()
  const targets = deriveRunningAgentSendTargets(state, input.worktreeId)
  const target = pickZotzFixChecksTarget(
    targets.filter((candidate) => !input.onlyIfIdle || candidate.entry?.state !== 'working'),
    state.activeTabIdByWorktree?.[input.worktreeId] ?? null
  )
  if (!target && input.onlyIfIdle) {
    return 'agent-busy'
  }
  const prompt = await buildPrompt(input.repo, input.review, input.checks)
  if (target) {
    const result = await sendMessageToAgent({
      worktreeId: input.worktreeId,
      target: runningAgentMessageTarget(target),
      prompt
    })
    return result.status === 'sent' || result.status === 'unconfirmed' ? 'sent' : 'failed'
  }
  const started = await startFixChecksAgent({
    repoId: input.repo.id,
    basePrompt: prompt,
    worktreeId: input.worktreeId,
    groupId: input.worktreeId,
    launchSource: 'task_page'
  })
  return started ? 'launched' : 'failed'
}
