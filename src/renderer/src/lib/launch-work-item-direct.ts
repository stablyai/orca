import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { waitForAgentReady } from '@/lib/agent-ready-wait'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  CLIENT_PLATFORM,
  getLinkedWorkItemSuggestedName,
  getSetupConfig,
  getWorkspaceSeedName
} from '@/lib/new-workspace'
import type { OrcaHooks, RepoHookSettings, SetupDecision, TuiAgent } from '../../../shared/types'

export type LaunchableWorkItem = {
  title: string
  url: string
  type: 'issue' | 'pr'
  number: number | null
  repoId?: string
  /** Content to paste into the agent's input. Defaults to the URL when omitted. */
  pasteContent?: string
}

// Why: bracketed paste markers let modern TUIs treat the inserted text as a
// single atomic paste — Claude Code / Codex / Gemini put it in their input
// buffer as a draft instead of echoing character-by-character. Intentionally
// omit a trailing '\r' so the draft never auto-submits; the user gets to
// review and send the prompt themselves.
const BRACKETED_PASTE_BEGIN = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

export type LaunchWorkItemDirectArgs = {
  item: LaunchableWorkItem
  repoId: string
  /** Called when the flow cannot proceed without user input (setup policy is
   *  `ask`, or the selected repo cannot resolve). Callers wire this to the
   *  existing modal opener so the user still gets a path forward. */
  openModalFallback: () => void
}

function pickAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detected: Set<TuiAgent>
): TuiAgent | null {
  // Why: honor the explicit default when the agent is actually installed. A
  // stale preference (uninstalled binary) must not block the flow — fall
  // through to the first matching detected agent in catalog order, which
  // matches the quick-composer's auto-pick behavior and keeps the experience
  // consistent regardless of where the user launches the workspace from.
  if (preferred && preferred !== 'blank' && detected.has(preferred)) {
    return preferred
  }
  for (const entry of AGENT_CATALOG) {
    if (detected.has(entry.id)) {
      return entry.id
    }
  }
  return null
}

async function resolveSetupDecision(
  repoId: string,
  repo: { hookSettings?: RepoHookSettings }
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    const result = await window.api.hooks.check({ repoId })
    yamlHooks = (result.hooks as OrcaHooks | null) ?? null
  } catch {
    yamlHooks = null
  }
  const setupConfig = getSetupConfig(repo, yamlHooks)
  if (!setupConfig) {
    // Why: no setup script configured → the decision is irrelevant but `inherit`
    // keeps the main-side behavior consistent with callers that don't pass one.
    return { kind: 'decided', decision: 'inherit' }
  }
  const policy = repo.hookSettings?.setupRunPolicy ?? 'run-by-default'
  if (policy === 'ask') {
    return { kind: 'needs-modal' }
  }
  return {
    kind: 'decided',
    decision: policy === 'run-by-default' ? 'run' : 'skip'
  }
}

/**
 * "Use" flow: create the workspace, activate it, launch the default agent,
 * and paste the work item URL into the agent's prompt as a draft (no submit).
 *
 * Falls back to `openModalFallback()` when:
 *   - the repo's `setupRunPolicy` is `'ask'` (the user must pick per-workspace)
 *   - the repo can't be resolved from `repoId`
 *   - no compatible agent is detected on PATH
 *
 * Best-effort: after the workspace is created and activated, failures during
 * the agent-readiness or paste steps only toast a notice — the user still
 * has a usable workspace and can paste the URL themselves.
 */
export async function launchWorkItemDirect(args: LaunchWorkItemDirectArgs): Promise<void> {
  const { item, repoId, openModalFallback } = args
  const store = useAppStore.getState()
  const repo = store.repos.find((r) => r.id === repoId)
  if (!repo) {
    openModalFallback()
    return
  }

  const settings = store.settings
  const detectedIds = new Set(await store.ensureDetectedAgents())
  const effectiveAgent = pickAgent(settings?.defaultTuiAgent, detectedIds)

  const setupResolution = await resolveSetupDecision(repoId, repo)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return
  }

  const workspaceName = getWorkspaceSeedName({
    explicitName: getLinkedWorkItemSuggestedName(item),
    prompt: '',
    linkedIssueNumber: item.type === 'issue' ? (item.number ?? null) : null,
    linkedPR: item.type === 'pr' ? (item.number ?? null) : null
  })

  // Why: launch the agent with no prompt so the first frame it draws is the
  // empty input box. The URL paste below populates that input buffer, which
  // gives the user a reviewable draft instead of a submitted request.
  const startupPlan =
    effectiveAgent === null
      ? null
      : buildAgentStartupPlan({
          agent: effectiveAgent,
          prompt: '',
          cmdOverrides: settings?.agentCmdOverrides ?? {},
          platform: CLIENT_PLATFORM,
          allowEmptyPromptLaunch: true
        })

  let worktreeId: string
  let primaryTabId: string | null
  try {
    const result = await store.createWorktree(
      repoId,
      workspaceName,
      undefined,
      setupResolution.decision
    )
    worktreeId = result.worktree.id

    const activation = activateAndRevealWorktree(worktreeId, {
      setup: result.setup,
      ...(startupPlan ? { startup: { command: startupPlan.launchCommand } } : {})
    })
    if (!activation) {
      // Worktree vanished between create and activate — extremely unlikely but
      // worth handling explicitly rather than silently dropping the URL.
      toast.error('Workspace created but could not be activated.')
      return
    }
    primaryTabId = activation.primaryTabId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
    return
  }

  const meta: { linkedIssue?: number; linkedPR?: number } = {}
  if (item.type === 'issue' && item.number) {
    meta.linkedIssue = item.number
  } else if (item.type === 'pr' && item.number) {
    meta.linkedPR = item.number
  }
  try {
    await store.updateWorktreeMeta(worktreeId, meta)
  } catch {
    // Meta update is non-critical for the draft flow — continue.
  }

  store.setSidebarOpen(true)
  if (settings?.rightSidebarOpenByDefault) {
    store.setRightSidebarTab('explorer')
    store.setRightSidebarOpen(true)
  }

  // Why: at this point the workspace is live and the agent (if any) has been
  // queued on `primaryTabId`. The paste step below is the only remaining
  // draft-specific work; bail out cleanly when either prerequisite is missing.
  if (!primaryTabId || !startupPlan) {
    return
  }

  const readyResult = await waitForAgentReady(primaryTabId, startupPlan.expectedProcess, {
    timeoutMs: 5000
  })
  if (!readyResult.ready) {
    toast.message(
      'Agent took too long to start. The workspace is ready — paste the issue URL when the agent is idle.'
    )
    return
  }

  const finalState = useAppStore.getState()
  const ptyId = finalState.ptyIdsByTabId[primaryTabId]?.[0]
  if (!ptyId) {
    return
  }

  // Why: TUIs must enable bracketed paste mode (\x1b[?2004h) before they can
  // interpret our paste markers. `title-idle` means the TUI has fully rendered
  // its input box and enabled paste mode; weaker signals (`foreground-match`,
  // `child-process`) only confirm the binary is running — the TUI's input
  // setup may still be in-flight, especially on slow shell environments.
  const graceMs = readyResult.reason === 'title-idle' ? 150 : 600
  await new Promise((resolve) => window.setTimeout(resolve, graceMs))

  const content = item.pasteContent ?? item.url
  window.api.pty.write(ptyId, `${BRACKETED_PASTE_BEGIN}${content}${BRACKETED_PASTE_END}`)
}
