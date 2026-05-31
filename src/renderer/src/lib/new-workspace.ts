import { useAppStore } from '@/store'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { isShellProcess } from '@/lib/tui-agent-startup'
import type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'
import type { OrcaHooks, TaskViewPresetId } from '../../../shared/types'
import { resolveHookCommandSourcePolicy } from '../../../shared/hook-command-source-policy'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import { slugifyForWorkspaceName } from '../../../shared/workspace-name'
export { getLinkedWorkItemSuggestedName } from '../../../shared/workspace-name'

/**
 * Why: the TaskPage's preset buttons and the openTaskPage prefetcher both need
 * to compute the same GitHub query string for a given preset id. Keep the
 * mapping here so the prefetch warms exactly the cache key the page will look
 * up on mount.
 */
export { PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT } from '../../../shared/work-items'

export function getTaskPresetQuery(presetId: TaskViewPresetId | null): string {
  switch (presetId) {
    case 'all':
    case 'issues':
      return 'is:issue is:open'
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case null:
      return 'is:issue is:open'
  }
}

export const IS_MAC = navigator.userAgent.includes('Mac')
export const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : IS_MAC
    ? 'darwin'
    : 'linux'

export type { LinkedWorkItemContext } from '@/lib/linked-work-item-context'

export type LinkedWorkItemSummary = {
  /** 'mr' is the GitLab analogue of 'pr'. The shape is otherwise
   *  identical so the linked-work-item badge in the composer renders
   *  uniformly across providers. */
  type: 'issue' | 'pr' | 'mr'
  number: number
  title: string
  url: string
  /** Linear identifier (for example ENG-123) when this linked item came from
   *  Linear rather than GitHub. */
  linearIdentifier?: string
  linkedContext?: LinkedWorkItemContext
}

export function isGitLabIssueUrl(url: string): boolean {
  // Why: self-hosted GitLab issue URLs may not contain "gitlab"; the
  // provider-stable signal is the `/-/issues/` path segment.
  try {
    return new URL(url).pathname.includes('/-/issues/')
  } catch {
    return /\/-\/issues\//i.test(url)
  }
}

// Why: when a repo has no `orca.yaml` issueCommand and no per-user override,
// we still want the composer to send a useful default prompt whenever the user
// attaches a linked work item without typing anything else. "Complete <url>"
// is the minimum viable instruction that always produces a coherent agent task.
export const DEFAULT_ISSUE_COMMAND_TEMPLATE = 'Complete {{artifact_url}}'

export type SetupConfig = { source: 'yaml' | 'local' | 'both'; command: string }

/**
 * Substitute the issue-command template variables. Prefers `{{artifact_url}}`
 * and keeps `{{issue}}` working silently for repos that have not migrated
 * their `orca.yaml` / `.orca/issue-command` yet.
 */
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

export function buildAgentPromptWithContext(
  prompt: string,
  attachments: string[],
  linkedUrls: string[],
  linkedContextBlocks: string[] = []
): string {
  const trimmedPrompt = prompt.trim()
  if (attachments.length === 0 && linkedUrls.length === 0 && linkedContextBlocks.length === 0) {
    return trimmedPrompt
  }

  const sections: string[] = []
  if (attachments.length > 0) {
    const attachmentBlock = attachments.map((pathValue) => `- ${pathValue}`).join('\n')
    sections.push(`Attachments:\n${attachmentBlock}`)
  }
  if (linkedUrls.length > 0) {
    const linkBlock = linkedUrls.map((url) => `- ${url}`).join('\n')
    sections.push(`Linked work items:\n${linkBlock}`)
  }
  if (linkedContextBlocks.length > 0) {
    sections.push(linkedContextBlocks.join('\n\n'))
  }
  // Why: the new-workspace flow launches each agent with a single plain-text
  // startup prompt. Appending attachments and bounded linked context keeps
  // extra data visible to Claude/Codex/OpenCode without cluttering the textarea.
  if (!trimmedPrompt) {
    return sections.join('\n\n')
  }
  return `${trimmedPrompt}\n\n${sections.join('\n\n')}`
}

export function getAttachmentLabel(pathValue: string): string {
  const segments = pathValue.split(/[/\\]/)
  return segments.at(-1) || pathValue
}

export function getSetupConfig(
  repo:
    | {
        hookSettings?: {
          commandSourcePolicy?: unknown
          scripts?: { setup?: string }
        }
      }
    | undefined,
  yamlHooks: OrcaHooks | null
): SetupConfig | null {
  const yamlSetup = yamlHooks?.scripts?.setup?.trim()
  const localSetup = repo?.hookSettings?.scripts?.setup?.trim()
  const sourcePolicy = resolveHookCommandSourcePolicy(repo?.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(localSetup)
  })

  if (sourcePolicy === 'local-only') {
    return localSetup ? { source: 'local', command: localSetup } : null
  }

  if (sourcePolicy === 'run-both' && yamlSetup && localSetup) {
    return { source: 'both', command: `${yamlSetup}\n${localSetup}` }
  }

  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }
  return null
}

export function getWorkspaceSeedName(args: {
  explicitName: string
  prompt: string
  linkedIssueNumber: number | null
  linkedPR: number | null
  /** Why: when none of the other seed sources produce a name, the composer
   *  supplies a repo-scoped unique marine-creature name so blank submissions
   *  still get a distinct, readable workspace rather than a collision-prone
   *  "workspace" literal that git would append numeric suffixes to. */
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
  // Why: the prompt is free-form user text — it can easily exceed a sane
  // branch-name length or be composed entirely of characters that
  // sanitizeWorktreeName strips (emoji, CJK, punctuation). Slugify + truncate
  // here so the downstream branch/path sanitizer always has a usable seed,
  // and fall back to the stable default when the prompt collapses to empty.
  if (prompt.trim()) {
    const slug = slugifyForWorkspaceName(prompt)
    if (slug) {
      return slug
    }
  }
  if (fallbackName && fallbackName.trim()) {
    return fallbackName.trim()
  }
  // Why: the prompt is optional in this flow. Fall back to a stable default
  // branch/workspace seed so users can launch an empty draft without first
  // writing a brief or naming the workspace manually.
  return 'workspace'
}

export async function ensureAgentStartupInTerminal(args: {
  worktreeId: string
  startup: AgentStartupPlan
}): Promise<void> {
  const { worktreeId, startup } = args
  const draftPrompt = startup.draftPrompt ?? null
  if (startup.followupPrompt === null && draftPrompt === null) {
    return
  }

  // Why: poll until a terminal tab + PTY exists for the worktree before we
  // can interact with it. Activation creates the tab synchronously but the
  // PTY spawn is async, so a brief wait is normal.
  let tabId: string | null = null
  let ptyId: string | null = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }
    const state = useAppStore.getState()
    tabId =
      state.activeTabIdByWorktree[worktreeId] ?? state.tabsByWorktree[worktreeId]?.[0]?.id ?? null
    if (!tabId) {
      continue
    }
    ptyId = state.ptyIdsByTabId[tabId]?.[0] ?? null
    if (ptyId) {
      break
    }
  }
  if (!tabId || !ptyId) {
    return
  }

  // Why: followupPrompt is the legacy path for stdin-after-start agents
  // (aider, goose, etc.) that need their initial prompt typed into the live
  // session and submitted. Wait until the agent owns the PTY before writing.
  if (startup.followupPrompt) {
    await waitForAgentForeground(ptyId, startup.expectedProcess)
    await sendFollowupPrompt(ptyId, startup.followupPrompt)
  }

  // Why: draftPrompt uses bracketed-paste so the URL lands atomically in the
  // agent's input buffer (no per-char echo, no auto-submit). Shared with the
  // launch-work-item-direct flow so both behave identically.
  if (draftPrompt) {
    await pasteDraftWhenAgentReady({
      tabId,
      content: draftPrompt,
      agent: startup.agent
    })
  }
}

async function sendFollowupPrompt(ptyId: string, prompt: string): Promise<boolean> {
  try {
    return await sendRuntimePtyInputVerified(useAppStore.getState().settings, ptyId, `${prompt}\r`)
  } catch {
    return false
  }
}

// Why: legacy followupPrompt path used `agentOwnsForeground` exclusively (with
// a hasChildProcesses fallback after several polls). Preserve that behavior so
// stdin-after-start agents still receive their prompt under the same
// conditions. Returns when the agent appears ready or the budget expires.
async function waitForAgentForeground(ptyId: string, expectedProcess: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }
    try {
      const process = await inspectRuntimeTerminalProcess(useAppStore.getState().settings, ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return
      }
      if (attempt >= 4 && !isShellProcess(foreground)) {
        if (process.hasChildProcesses) {
          return
        }
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
}
