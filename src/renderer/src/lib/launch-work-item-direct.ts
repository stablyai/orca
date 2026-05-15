import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { activateAndRevealWorktree, type AgentStartedTelemetry } from '@/lib/worktree-activation'
import {
  CLIENT_PLATFORM,
  getLinkedWorkItemSuggestedName,
  getSetupConfig,
  getWorkspaceSeedName
} from '@/lib/new-workspace'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import type {
  OrcaHooks,
  RepoHookSettings,
  SetupDecision,
  TuiAgent,
  WorkspaceCreateTelemetrySource
} from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'

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

// Why: bracketed paste markers and ready-wait grace timing live in
// agent-paste-draft.ts so the new-workspace and "Use" flows share one
// definition of "type into the agent's input as a non-submitted draft".

export type LaunchWorkItemDirectArgs = {
  item: LaunchableWorkItem
  repoId: string
  /** Called when the flow cannot proceed without user input (setup policy is
   *  `ask`, or the selected repo cannot resolve). Callers wire this to the
   *  existing modal opener so the user still gets a path forward. */
  openModalFallback: () => void
  /** Optional base branch to start the worktree from. When omitted the
   *  worktree inherits the repo's effective base ref. Used by the
   *  smart workspace-name PR selection to branch from the PR's head so the first
   *  commit lands on the correct base without the user touching the UI. */
  baseBranch?: string
  /** Telemetry surface that initiated this agent launch. Threaded into
   *  the queued startup payload so `agent_started.launch_source` reflects
   *  the actual entry point. */
  launchSource: LaunchSource
  /** Telemetry surface that initiated this launch. Threaded into
   *  `createWorktree` so `workspace_created.source` reflects the actual
   *  entry point (Tasks page row → `sidebar`, Create-from modal →
   *  `command_palette`). Omitted callers default to `unknown`. */
  telemetrySource?: WorkspaceCreateTelemetrySource
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
    const result = await checkRuntimeHooks(useAppStore.getState().settings, repoId)
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

// Why: telemetry rides the queued startup so main fires `agent_started`
// only after pty:spawn confirms the launch. No agent / no plan → no event.
function buildStartupOpts(
  agent: TuiAgent | null,
  plan: ReturnType<typeof buildAgentStartupPlan>,
  launchSource: LaunchSource
): {
  startup?: { command: string; env?: Record<string, string>; telemetry?: AgentStartedTelemetry }
} {
  if (!plan) {
    return {}
  }
  const telemetry: AgentStartedTelemetry | null =
    agent === null
      ? null
      : { agent_kind: tuiAgentToAgentKind(agent), launch_source: launchSource, request_kind: 'new' }
  return {
    startup: {
      command: plan.launchCommand,
      ...(plan.env ? { env: plan.env } : {}),
      ...(telemetry ? { telemetry } : {})
    }
  }
}

async function pasteWorkItemDraftWhenAgentReady(args: {
  primaryTabId: string
  startupPlan: NonNullable<ReturnType<typeof buildAgentStartupPlan>>
  content: string
  /** Telemetry-only: which agent the renderer thinks it launched, so an
   *  `agent_error` on timeout can carry the right `agent_kind`. */
  agentKind?: ReturnType<typeof tuiAgentToAgentKind>
}): Promise<void> {
  const { primaryTabId, startupPlan, content, agentKind } = args
  await pasteDraftWhenAgentReady({
    tabId: primaryTabId,
    content,
    agent: startupPlan.agent,
    onTimeout: () => {
      toast.message(
        'Agent took too long to start. The workspace is ready — paste the issue URL when the agent is idle.'
      )
      // Why: process-startup timeout has no v1 enum slot; the `unknown` slice
      // on the dashboard is the trigger to add one.
      if (agentKind) {
        track('agent_error', { error_class: 'unknown', agent_kind: agentKind })
      }
    }
  })
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
  const { item, repoId, openModalFallback, baseBranch, telemetrySource, launchSource } = args
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
  let effectiveAgent: TuiAgent | null = null
  let draftLaunchedNatively = false
  try {
    const result = await store.createWorktree(
      repoId,
      workspaceName,
      baseBranch,
      finalSetupDecision,
      undefined,
      telemetrySource,
      item.title,
      item.type === 'issue' && item.number ? item.number : undefined,
      item.type === 'pr' && item.number ? item.number : undefined,
      undefined,
      undefined,
      item.linearIdentifier
    )
    worktreeId = result.worktree.id
    const worktreePath = result.worktree.path

    const detectedIds = new Set(await detectedAgentsPromise)
    effectiveAgent = pickAgent(settings?.defaultTuiAgent, detectedIds)
    if (effectiveAgent) {
      // Why: direct task launch creates and starts the workspace in separate
      // steps so agent detection can overlap git worktree creation. Persist
      // the chosen agent once known so empty-worktree reopen can recreate it.
      void store.updateWorktreeMeta(worktreeId, { createdWithAgent: effectiveAgent }).catch(() => {
        // Non-critical: activation still has the explicit startup below.
      })
    }
    const draftContent = item.pasteContent ?? item.url

    // Why: agents that gate first-launch behind a "Do you trust this folder?"
    // menu (cursor-agent, copilot) consume the bracketed paste as menu input.
    // Pre-write the same trust artifact those CLIs write after the user
    // accepts so the menu never fires. Best-effort — main swallows errors,
    // and we guard the IPC presence so a stale preload bundle (which can
    // ship a renderer that's ahead of the loaded preload) doesn't crash the
    // launch with "Cannot read properties of undefined".
    if (effectiveAgent && worktreePath && window.api.agentTrust?.markTrusted) {
      const preflight = TUI_AGENT_CONFIG[effectiveAgent].preflightTrust
      if (preflight) {
        try {
          await window.api.agentTrust.markTrusted({
            preset: preflight,
            workspacePath: worktreePath
          })
        } catch {
          // Best-effort: continue with launch even if the trust write
          // throws. The user can dismiss the trust menu manually.
        }
      }
    }

    // Why: prefer a native prefill flag (e.g. `claude --prefill <url>`) when
    // the agent's CLI exposes one — the TUI mounts with the URL already in
    // its input box, which sidesteps the readiness/paste race entirely. Fall
    // back to launching with no prompt + bracketed-paste-after-ready for
    // every other agent so the URL still lands as a draft (not auto-
    // submitted as the first turn).
    const draftLaunchPlan =
      effectiveAgent === null
        ? null
        : buildAgentDraftLaunchPlan({
            agent: effectiveAgent,
            draft: draftContent,
            cmdOverrides: settings?.agentCmdOverrides ?? {},
            platform: CLIENT_PLATFORM
          })
    if (draftLaunchPlan) {
      startupPlan = {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
      draftLaunchedNatively = true
    } else if (effectiveAgent !== null) {
      startupPlan = buildAgentStartupPlan({
        agent: effectiveAgent,
        prompt: '',
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM,
        allowEmptyPromptLaunch: true
      })
    }

    const activation = activateAndRevealWorktree(worktreeId, {
      setup: result.setup,
      ...buildStartupOpts(effectiveAgent, startupPlan, launchSource)
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

  store.setSidebarOpen(true)
  if (settings?.rightSidebarOpenByDefault) {
    store.setRightSidebarTab('explorer')
    store.setRightSidebarOpen(true)
  }

  // Why: at this point the workspace is live and the agent (if any) has
  // been queued on `primaryTabId`. The post-launch paste step below only
  // applies to agents that lacked a native prefill flag; for agents that
  // were launched with the URL already on argv (Claude --prefill today),
  // the URL is in the input box already — pasting again would duplicate it.
  if (!primaryTabId || !startupPlan || draftLaunchedNatively) {
    return
  }

  const content = item.pasteContent ?? item.url
  // Why: the workspace is already created and visible; do not block selection
  // latency on agent readiness. Run the paste in the background so the
  // "Use" CTA's spinner ends when the worktree is ready, not when the TUI
  // input buffer is ready.
  void pasteWorkItemDraftWhenAgentReady({
    primaryTabId,
    startupPlan,
    content,
    ...(effectiveAgent ? { agentKind: tuiAgentToAgentKind(effectiveAgent) } : {})
  })
}
