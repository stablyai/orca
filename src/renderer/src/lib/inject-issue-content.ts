import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { buildContainedLinkedContextBlock } from '@/lib/linked-work-item-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type {
  IssueContentInjectionPreference,
  Worktree,
  LinearIssue,
  GitHubWorkItemDetails,
  TuiAgent,
  GlobalSettings
} from '../../../shared/types'
import type { LinkedWorkItemContext } from './linked-work-item-context'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

export type InjectionDecision = 'inject' | 'skip' | 'ask'

export function resolveInjectionDecision(
  preference: IssueContentInjectionPreference | undefined,
  worktreeOverride: boolean | undefined
): InjectionDecision {
  if (worktreeOverride !== undefined) {
    return worktreeOverride ? 'inject' : 'skip'
  }

  const effectivePreference = preference ?? 'always'
  if (effectivePreference === 'always') {
    return 'inject'
  }
  if (effectivePreference === 'never') {
    return 'skip'
  }
  return 'ask'
}

export type FetchIssueContentResult =
  | { success: true; content: LinkedWorkItemContext }
  | { success: false; error: string }

async function fetchLinearIssueContent(
  worktree: Worktree,
  target: RuntimeClientTarget
): Promise<FetchIssueContentResult> {
  const issueId = worktree.linkedLinearIssue
  if (!issueId) {
    return { success: false, error: 'No Linear issue linked to worktree' }
  }

  const result =
    target.kind === 'local'
      ? await window.api.linear.getIssue({ id: issueId })
      : await callRuntimeRpc<LinearIssue | null>(target, 'linear.getIssue', {
          id: issueId
        })

  if (!result) {
    return { success: false, error: 'Linear issue not found' }
  }

  return {
    success: true,
    content: {
      provider: 'linear',
      version: 1,
      renderedText: `${result.title}\n\n${result.description || ''}`
    }
  }
}

async function fetchGitHubIssueContent(
  worktree: Worktree,
  target: RuntimeClientTarget,
  repoPath: string
): Promise<FetchIssueContentResult> {
  const issueNumber = worktree.linkedIssue
  if (!issueNumber) {
    return { success: false, error: 'No GitHub issue linked to worktree' }
  }

  const repoId = worktree.repoId
  const result =
    target.kind === 'local'
      ? await window.api.gh.workItemDetails({
          repoPath,
          repoId,
          number: issueNumber,
          type: 'issue'
        })
      : await callRuntimeRpc<GitHubWorkItemDetails | null>(target, 'github.workItemDetails', {
          repo: repoId,
          number: issueNumber,
          type: 'issue'
        })

  if (!result) {
    return { success: false, error: 'GitHub issue not found' }
  }

  return {
    success: true,
    content: {
      provider: 'github',
      version: 1,
      renderedText: `${result.item.title}\n\n${result.body || ''}`
    }
  }
}

export async function fetchIssueContent(args: {
  worktree: Worktree
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  repoPath?: string
}): Promise<FetchIssueContentResult> {
  const { worktree, settings, repoPath } = args

  try {
    const target = getActiveRuntimeTarget(settings)

    if (worktree.linkedLinearIssue) {
      return await fetchLinearIssueContent(worktree, target)
    }

    if (worktree.linkedIssue) {
      if (!repoPath) {
        return { success: false, error: 'repoPath is required for GitHub issue fetch' }
      }
      return await fetchGitHubIssueContent(worktree, target, repoPath)
    }

    return { success: false, error: 'No linked issue found on worktree' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Failed to fetch issue content for injection:', err)
    return { success: false, error: `Failed to fetch issue content: ${message}` }
  }
}

export type InjectIssueContentResult = { success: true } | { success: false; error: string }

export async function injectIssueContentIntoAgent(args: {
  tabId: string
  content: LinkedWorkItemContext
  agent?: TuiAgent
}): Promise<InjectIssueContentResult> {
  const { tabId, content, agent } = args

  const formatted = buildContainedLinkedContextBlock(content)
  if (!formatted) {
    return { success: false, error: 'Failed to format issue content for injection' }
  }

  const success = await pasteDraftWhenAgentReady({
    tabId,
    content: formatted,
    agent,
    submit: false,
    timeoutMs: 10000,
    onTimeout: () => {
      // Caller handles UI feedback
    }
  })

  if (!success) {
    return {
      success: false,
      error: 'Could not inject issue content into agent chat. The agent may still be starting.'
    }
  }

  return { success: true }
}
