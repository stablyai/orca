import { useAppStore } from '@/store'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import { isShellProcess } from '@/lib/tui-agent-startup'
import type { GitHubWorkItem, OrcaHooks, TaskViewPresetId } from '../../../shared/types'

/**
 * Why: the TaskPage's preset buttons and the openTaskPage prefetcher both need
 * to compute the same GitHub query string for a given preset id. Keep the
 * mapping here so the prefetch warms exactly the cache key the page will look
 * up on mount.
 */
export function getTaskPresetQuery(presetId: TaskViewPresetId | null): string {
  switch (presetId) {
    case 'my-issues':
      return 'assignee:@me is:open'
    case 'review':
      return 'review-requested:@me is:open'
    case 'my-prs':
      return 'author:@me is:open'
    default:
      return 'is:open'
  }
}

export const IS_MAC = navigator.userAgent.includes('Mac')
export const ADD_ATTACHMENT_SHORTCUT = IS_MAC ? '⌘U' : 'Ctrl+U'
export const CLIENT_PLATFORM: NodeJS.Platform = navigator.userAgent.includes('Windows')
  ? 'win32'
  : IS_MAC
    ? 'darwin'
    : 'linux'

export type LinkedWorkItemSummary = {
  type: 'issue' | 'pr'
  number: number
  title: string
  url: string
}

// Why: when a repo has no `orca.yaml` issueCommand and no per-user override,
// we still want the composer to send a useful default prompt whenever the user
// attaches a linked work item without typing anything else. "Complete <url>"
// is the minimum viable instruction that always produces a coherent agent task.
export const DEFAULT_ISSUE_COMMAND_TEMPLATE = 'Complete {{artifact_url}}'

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
  linkedUrls: string[]
): string {
  const trimmedPrompt = prompt.trim()
  if (attachments.length === 0 && linkedUrls.length === 0) {
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
  // Why: the new-workspace flow launches each agent with a single plain-text
  // startup prompt. Appending attachments and linked URLs keeps extra context
  // visible to Claude/Codex/OpenCode without cluttering the visible textarea.
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
  repo: { hookSettings?: { scripts?: { setup?: string } } } | undefined,
  yamlHooks: OrcaHooks | null
): { source: 'yaml' | 'legacy'; command: string } | null {
  const yamlSetup = yamlHooks?.scripts?.setup?.trim()
  if (yamlSetup) {
    return { source: 'yaml', command: yamlSetup }
  }
  const legacySetup = repo?.hookSettings?.scripts?.setup?.trim()
  if (legacySetup) {
    return { source: 'legacy', command: legacySetup }
  }
  return null
}

// Why: branch names and on-disk worktree directories must be short, lowercase,
// and ASCII-safe. Free-form text (prompts, GitHub titles) often contains
// emoji, CJK, or hundreds of characters, which would otherwise make
// sanitizeWorktreeName either produce a ludicrously long name or throw
// "Invalid worktree name" when every character is stripped.
function slugifyForWorkspaceName(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[\\/]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      // Why: git check-ref-format rejects any ref containing `..`, so a prompt
      // like "../../foo" must not turn into a branch seed with internal `..`
      // sequences (the main-process sanitizer collapses these too, but we
      // mirror the rule here so the renderer preview matches the real name).
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 48)
      .replace(/[-._]+$/g, '')
  )
}

export function getLinkedWorkItemSuggestedName(item: GitHubWorkItem): string {
  const withoutLeadingNumber = item.title
    .trim()
    .replace(/^(?:issue|pr|pull request)\s*#?\d+\s*[:-]\s*/i, '')
    .replace(/^#\d+\s*[:-]\s*/, '')
    .replace(/\(#\d+\)/gi, '')
    .replace(/\b#\d+\b/g, '')
    .trim()
  const seed = withoutLeadingNumber || item.title.trim()
  return slugifyForWorkspaceName(seed)
}

export function getWorkspaceSeedName(args: {
  explicitName: string
  prompt: string
  linkedIssueNumber: number | null
  linkedPR: number | null
}): string {
  const { explicitName, prompt, linkedIssueNumber, linkedPR } = args
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
  if (startup.followupPrompt === null) {
    return
  }

  let promptInjected = false

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 150))
    }

    const state = useAppStore.getState()
    const tabId =
      state.activeTabIdByWorktree[worktreeId] ?? state.tabsByWorktree[worktreeId]?.[0]?.id ?? null
    if (!tabId) {
      continue
    }

    const ptyId = state.ptyIdsByTabId[tabId]?.[0]
    if (!ptyId) {
      continue
    }

    try {
      const foreground = (await window.api.pty.getForegroundProcess(ptyId))?.toLowerCase() ?? ''
      const agentOwnsForeground =
        foreground === startup.expectedProcess ||
        foreground.startsWith(`${startup.expectedProcess}.`)

      if (agentOwnsForeground && !promptInjected && startup.followupPrompt) {
        window.api.pty.write(ptyId, `${startup.followupPrompt}\r`)
        promptInjected = true
        return
      }

      if (agentOwnsForeground && promptInjected) {
        return
      }

      const hasChildProcesses = await window.api.pty.hasChildProcesses(ptyId)
      if (
        !promptInjected &&
        startup.followupPrompt &&
        hasChildProcesses &&
        !isShellProcess(foreground) &&
        attempt >= 4
      ) {
        // Why: the initial agent launch is already queued on the first terminal
        // tab. Only agents without a verified startup-prompt flag need extra
        // help here: once the TUI owns the PTY, type the draft prompt into the
        // live session instead of launching the binary a second time.
        window.api.pty.write(ptyId, `${startup.followupPrompt}\r`)
        promptInjected = true
        return
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
}
