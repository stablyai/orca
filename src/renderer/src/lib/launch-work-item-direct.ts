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
import { getSuggestedCreatureName } from '@/components/sidebar/worktree-name-suggestions'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import type { OrcaHooks, RepoHookSettings, SetupDecision, TuiAgent } from '../../../shared/types'

export type LaunchableWorkItem = {
  title: string
  url: string
  type: 'issue' | 'pr'
  number: number | null
  repoId?: string
  /** Content to paste into the agent's input. Defaults to the URL when omitted. */
  pasteContent?: string
  /** Linear identifier (e.g. "ENG-123") when the work item originates from
   *  Linear. Persisted to worktree meta as `linkedLinearIssue` so the sidebar
   *  and other surfaces can surface the Linear link. Linear issues also pass
   *  `type: 'issue'` / `number: null` to reuse the GitHub draft-paste flow,
   *  so this field is the only signal that the worktree is Linear-linked. */
  linearIdentifier?: string
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
  /** Optional base branch to start the worktree from. When omitted the
   *  worktree inherits the repo's effective base ref. Used by the
   *  "Create from…" PR row to branch from the PR's head so the first
   *  commit lands on the correct base without the user touching the UI. */
  baseBranch?: string
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

async function pasteWorkItemDraftWhenAgentReady(args: {
  primaryTabId: string
  startupPlan: NonNullable<ReturnType<typeof buildAgentStartupPlan>>
  content: string
}): Promise<void> {
  const { primaryTabId, startupPlan, content } = args
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

  window.api.pty.write(ptyId, `${BRACKETED_PASTE_BEGIN}${content}${BRACKETED_PASTE_END}`)
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
  const { item, repoId, openModalFallback, baseBranch } = args
  const store = useAppStore.getState()
  const repo = store.repos.find((r) => r.id === repoId)
  if (!repo) {
    openModalFallback()
    return
  }

  const settings = store.settings
  // Why: agent detection shells out and can be cold/slow. Start it now, but
  // don't let it serialize setup-policy resolution or git worktree creation.
  const detectedAgentsPromise = store.ensureDetectedAgents()

  const setupResolution = await resolveSetupDecision(repoId, repo)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return
  }

  const trustDecision = await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
  const finalSetupDecision: SetupDecision =
    trustDecision === 'skip' ? 'skip' : setupResolution.decision

  const workspaceName = getWorkspaceSeedName({
    explicitName: getLinkedWorkItemSuggestedName(item),
    prompt: '',
    linkedIssueNumber: item.type === 'issue' ? (item.number ?? null) : null,
    linkedPR: item.type === 'pr' ? (item.number ?? null) : null
  })

  let worktreeId: string
  let primaryTabId: string | null
  let startupPlan: ReturnType<typeof buildAgentStartupPlan> = null
  try {
    const result = await store.createWorktree(repoId, workspaceName, baseBranch, finalSetupDecision)
    worktreeId = result.worktree.id

    const detectedIds = new Set(await detectedAgentsPromise)
    const effectiveAgent = pickAgent(settings?.defaultTuiAgent, detectedIds)
    // Why: launch the agent with no prompt so the first frame it draws is the
    // empty input box. The URL paste below populates that input buffer, which
    // gives the user a reviewable draft instead of a submitted request.
    startupPlan =
      effectiveAgent === null
        ? null
        : buildAgentStartupPlan({
            agent: effectiveAgent,
            prompt: '',
            cmdOverrides: settings?.agentCmdOverrides ?? {},
            platform: CLIENT_PLATFORM,
            allowEmptyPromptLaunch: true
          })

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

  const meta: {
    linkedIssue?: number
    linkedPR?: number
    linkedLinearIssue?: string
  } = {}
  if (item.type === 'issue' && item.number) {
    meta.linkedIssue = item.number
  } else if (item.type === 'pr' && item.number) {
    meta.linkedPR = item.number
  }
  if (item.linearIdentifier) {
    meta.linkedLinearIssue = item.linearIdentifier
  }
  if (Object.keys(meta).length > 0) {
    void store.updateWorktreeMeta(worktreeId, meta).catch(() => {
      // Meta update is non-critical for the draft flow — continue.
    })
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

  const content = item.pasteContent ?? item.url
  // Why: the workspace is already created and visible; waiting up to 5s for
  // agent readiness here kept the Create-from modal in "Creating workspace…".
  // Continue the draft paste in the background so selection latency ends when
  // the worktree is ready, not when the TUI input buffer is ready.
  void pasteWorkItemDraftWhenAgentReady({ primaryTabId, startupPlan, content })
}

export type LaunchFromBranchArgs = {
  repoId: string
  baseBranch: string
  /** Called when the flow cannot proceed without user input (setup policy is
   *  `ask`, or the selected repo cannot resolve). */
  openModalFallback: () => void
}

/**
 * Create a workspace from a specific branch with no linked work item. Skips
 * the bracketed-paste draft step — there's no URL to hand the agent, so we
 * just land the user in a fresh workspace rooted at the requested branch.
 */
export async function launchFromBranch(args: LaunchFromBranchArgs): Promise<void> {
  const { repoId, baseBranch, openModalFallback } = args
  const store = useAppStore.getState()
  const repo = store.repos.find((r) => r.id === repoId)
  if (!repo) {
    openModalFallback()
    return
  }

  const settings = store.settings
  // Why: keep agent detection off the critical path while we resolve setup
  // policy. Worktree creation only needs the startup command at activation.
  const detectedAgentsPromise = store.ensureDetectedAgents()

  const setupResolution = await resolveSetupDecision(repoId, repo)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return
  }

  const trustDecision = await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
  const finalSetupDecision: SetupDecision =
    trustDecision === 'skip' ? 'skip' : setupResolution.decision

  // Why: branch-based launches don't carry a title hint, so fall back to the
  // repo's creature-name generator — same distinct, readable default the
  // quick-composer uses when the name field is blank.
  const fallbackName = getSuggestedCreatureName(
    repoId,
    store.worktreesByRepo,
    settings?.nestWorkspaces ?? true
  )
  const workspaceName = getWorkspaceSeedName({
    explicitName: '',
    prompt: '',
    linkedIssueNumber: null,
    linkedPR: null,
    fallbackName
  })

  try {
    const result = await store.createWorktree(repoId, workspaceName, baseBranch, finalSetupDecision)
    const detectedIds = new Set(await detectedAgentsPromise)
    const effectiveAgent = pickAgent(settings?.defaultTuiAgent, detectedIds)
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
    const activation = activateAndRevealWorktree(result.worktree.id, {
      setup: result.setup,
      ...(startupPlan ? { startup: { command: startupPlan.launchCommand } } : {})
    })
    if (!activation) {
      toast.error('Workspace created but could not be activated.')
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
    return
  }

  store.setSidebarOpen(true)
  if (settings?.rightSidebarOpenByDefault) {
    store.setRightSidebarTab('explorer')
    store.setRightSidebarOpen(true)
  }
}
