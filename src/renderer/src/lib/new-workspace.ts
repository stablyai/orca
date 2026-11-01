import { useAppStore } from '@/store'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-paste-draft'
import { sendFollowupPromptWhenAgentReady } from '@/lib/agent-followup-delivery'
import { showAutomationPromptNotSentToast } from '@/lib/agent-background-session-timeout-toast'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import {
  beginAgentStartupDeliveryAttempt,
  getAgentStartupTabPtyId,
  queuePendingAgentStartupDelivery,
  resolveAgentStartupTabId
} from '@/lib/agent-startup-delayed-delivery'
import type { FolderWorkspaceLinkedTask } from '../../../shared/folder-workspace-types'
import { slugifyForWorkspaceName } from '../../../shared/workspace-name'
import { createBrowserUuid } from '@/lib/browser-uuid'
export { getLinkedWorkItemSuggestedName } from '../../../shared/workspace-name'
export { getLinkedWorkItemWorkspaceName } from '../../../shared/workspace-name'
export { getWorkspaceIntentName } from '../../../shared/workspace-name'

export { PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT } from '../../../shared/work-items'

export const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : navigator.userAgent.includes('Mac')
    ? 'darwin'
    : 'linux'

export { getLinkedWorkItemProvider, isGitLabIssueUrl } from './linked-work-item-provider'

export type LinkedWorkItemSummary = Omit<FolderWorkspaceLinkedTask, 'provider'> & {
  provider?: FolderWorkspaceLinkedTask['provider']
  linearWorkspaceId?: string
  linearOrganizationUrlKey?: string
  linearBranchName?: string
  linkedContext?: LinkedWorkItemContext
}

export function canUseIssueCommandForLinkedItemProvider(
  provider: FolderWorkspaceLinkedTask['provider'] | null
): boolean {
  return provider === 'github' || provider === 'gitlab'
}

// Linked work items without user prompt or issueCommand still need an actionable default task.
export const DEFAULT_ISSUE_COMMAND_TEMPLATE = 'Complete {{artifact_url}}'

/** Prefer artifact_url while retaining issue substitutions for unmigrated orca.yaml/.orca/issue-command templates. */
export function renderIssueCommandTemplate(
  template: string,
  vars: { issueNumber: number | null; artifactUrl: string | null }
): string {
  const { issueNumber, artifactUrl } = vars
  let rendered = template
  if (artifactUrl !== null) {
    rendered = rendered.replace(/\{\{artifact_url\}\}/g, artifactUrl)
  }
  if (issueNumber !== null) {
    rendered = rendered.replace(/\{\{issue\}\}/g, String(issueNumber))
  }
  return rendered
}

export function getAttachmentLabel(pathValue: string): string {
  const segments = pathValue.split(/[/\\]/)
  return segments.at(-1) || pathValue
}

export function getWorkspaceSeedName(args: {
  explicitName: string
  prompt: string
  linkedIssueNumber: number | null
  linkedPR: number | null
  /** Use repo-unique marine names when other sources yield none; literal workspace seeds collide. */
  fallbackName?: string
}): string {
  const { explicitName, prompt, linkedIssueNumber, linkedPR, fallbackName } = args
  if (explicitName.trim()) {
    return explicitName.trim()
  }
  if (linkedPR !== null) {
    return `pr-${linkedPR}`
  }
  if (linkedIssueNumber !== null) {
    return `issue-${linkedIssueNumber}`
  }
  // Bound free-form prompts to usable branch seeds; emoji/CJK/punctuation may sanitize away entirely, requiring stable fallback.
  if (prompt.trim()) {
    const slug = slugifyForWorkspaceName(prompt)
    if (slug) {
      return slug
    }
  }
  if (fallbackName && fallbackName.trim()) {
    return fallbackName.trim()
  }
  // Optional empty prompts still need a stable workspace/branch seed.
  return 'workspace'
}

export async function ensureAgentStartupInTerminal(args: {
  worktreeId: string
  primaryTabId?: string | null
  startup: AgentStartupPlan
}): Promise<void> {
  const { worktreeId, primaryTabId, startup } = args
  const draftPrompt = startup.draftPrompt ?? null
  if (startup.followupPrompt === null && draftPrompt === null) {
    return
  }
  const launchToken = ensureStartupLaunchToken(startup)

  // Activation creates tabs synchronously but PTYs asynchronously; wait for both before input.
  let tabId: string | null = null
  let ptyId: string | null = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    const state = useAppStore.getState()
    tabId = resolveAgentStartupTabId(state, worktreeId, primaryTabId)
    if (!tabId) {
      continue
    }
    ptyId = getAgentStartupTabPtyId(state, tabId, launchToken)
    if (ptyId) {
      break
    }
  }
  if (!tabId || !ptyId) {
    if (tabId) {
      // Background tabs may stay unmounted beyond readiness budgets; bind delivery to the seed until reveal spawns its PTY.
      queuePendingAgentStartupDelivery({
        worktreeId,
        tabId,
        launchToken,
        startup,
        deliver: deliverAgentStartupToTerminal
      })
    }
    return
  }

  if (beginAgentStartupDeliveryAttempt({ worktreeId, tabId, launchToken })) {
    await deliverAgentStartupToTerminal(tabId, ptyId, startup)
  }
}

async function deliverAgentStartupToTerminal(
  _tabId: string,
  ptyId: string,
  startup: AgentStartupPlan
): Promise<void> {
  const draftPrompt = startup.draftPrompt ?? null
  // Legacy stdin-after-start agents need live typed/submitted prompts; wait for agent ownership before writing.
  if (startup.followupPrompt) {
    const delivered = await sendFollowupPromptWhenAgentReady({
      ptyId,
      agent: startup.agent,
      expectedProcess: startup.expectedProcess,
      prompt: startup.followupPrompt
    })
    // Report dropped follow-ups so users know to open the workspace and paste manually.
    if (!delivered) {
      showAutomationPromptNotSentToast(startup.agent)
    }
  }

  // Share atomic unsubmitted bracketed paste with direct work-item launches.
  if (draftPrompt) {
    await pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: draftPrompt,
      agent: startup.agent,
      // draftPrompt exists only without native-prefill delivery, so this paste is the first attempt.
      forcePaste: true,
      // Why: surface a dropped draft instead of silently losing it.
      onTimeout: () => showAutomationPromptNotSentToast(startup.agent)
    })
  }
}

function ensureStartupLaunchToken(startup: AgentStartupPlan): string {
  if (!startup.launchToken) {
    // Reuse the startup launch token for retries so they match the pane’s delivery registration.
    startup.launchToken = createBrowserUuid()
  }
  return startup.launchToken
}
