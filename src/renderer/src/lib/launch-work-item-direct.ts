import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  planAgentCliArgsSuffix
} from '@/lib/tui-agent-startup'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getWorkspaceIntentName, getWorkspaceSeedName, isGitLabIssueUrl } from '@/lib/new-workspace'
import {
  getLaunchableWorkItemDraftContent,
  type LinkedWorkItemContext
} from '@/lib/linked-work-item-context'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getConnectionId } from '@/lib/connection-context'
import type {
  GitPushTarget,
  SetupDecision,
  TuiAgent,
  WorkspaceCreateTelemetrySource
} from '../../../shared/types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import {
  buildDirectWorkItemStartupOpts,
  pasteDirectWorkItemDraftWhenAgentReady
} from '@/lib/launch-work-item-direct-agent'
import {
  resolveDirectPrStartPoint,
  resolveDirectSetupDecision
} from '@/lib/launch-work-item-direct-preflight'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { translate } from '@/i18n/i18n'

export type LaunchableWorkItem = {
  title: string
  url: string
  type: 'issue' | 'pr' | 'mr'
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
  linkedContext?: LinkedWorkItemContext
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
  /** Explicit agent chosen by an action-time composer. When unavailable after
   *  workspace creation, Orca must not fall back to a different agent. */
  agentOverride?: TuiAgent
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  /** Controls whether pasted work-item content remains editable or starts the
   *  agent immediately after the TUI is ready. */
  promptDelivery?: 'draft' | 'submit-after-ready'
  /** Shell platform for the host that will execute the startup command. */
  launchPlatform?: NodeJS.Platform
}

function getDirectDraftContent(item: LaunchableWorkItem): string {
  return getLaunchableWorkItemDraftContent(item)
}

/**
 * "Use" flow: create the workspace, activate it, launch the default agent,
 * and paste the work item context into the agent. Most callers leave it as a draft;
 * fix-check launches can opt into submitting the prompt after the TUI is ready.
 *
 * Falls back to `openModalFallback()` when:
 *   - the repo's `setupRunPolicy` is `'ask'` (the user must pick per-workspace)
 *   - the repo can't be resolved from `repoId`
 *   - no compatible agent is detected on PATH
 *
 * Best-effort: after the workspace is created and activated, failures during
 * the agent-readiness or paste steps only toast a notice — the user still
 * has a usable workspace and can paste the work item context themselves.
 */
export async function launchWorkItemDirect(args: LaunchWorkItemDirectArgs): Promise<boolean> {
  const {
    item,
    repoId,
    openModalFallback,
    baseBranch,
    telemetrySource,
    launchSource,
    agentOverride,
    agentArgs
  } = args
  const store = useAppStore.getState()
  const repo = store.repos.find((r) => r.id === repoId)
  if (!repo) {
    openModalFallback()
    return false
  }

  const settings = store.settings
  const promptDelivery = args.promptDelivery ?? 'draft'
  const repoConnectionId = repo.connectionId?.trim() || null
  const preflightLaunchPlatform =
    args.launchPlatform ??
    resolveSourceControlLaunchPlatform({
      connectionId: repoConnectionId,
      worktreePath: repo.path
    })
  const agentArgsPlan = planAgentCliArgsSuffix(
    agentArgs,
    preflightLaunchPlatform === 'win32' ? 'powershell' : 'posix'
  )
  if (!agentArgsPlan.ok) {
    // Why: direct launches may create a worktree before the agent startup plan
    // is built; reject malformed saved args before touching user workspaces.
    toast.error(agentArgsPlan.error)
    return false
  }
  // Why: agent detection shells out and can be cold/slow. Start it now, but
  // don't let it serialize setup-policy resolution or git worktree creation.
  const detectedAgentsPromise = agentOverride
    ? null
    : repoConnectionId
      ? store.ensureRemoteDetectedAgents(repoConnectionId)
      : store.ensureDetectedAgents()

  const setupResolution = await resolveDirectSetupDecision(repoId, repo)
  if (setupResolution.kind === 'needs-modal') {
    openModalFallback()
    return false
  }

  const trustDecision = await ensureHooksConfirmed(useAppStore.getState(), repoId, 'setup')
  const finalSetupDecision: SetupDecision =
    trustDecision === 'skip' ? 'skip' : setupResolution.decision

  const workspaceIntentName =
    item.number !== null
      ? getWorkspaceIntentName({
          sourceText: item.pasteContent,
          workItem: { ...item, number: item.number }
        })
      : null
  const workspaceName = getWorkspaceSeedName({
    explicitName: item.linearIdentifier
      ? getLinearIssueWorkspaceName({ identifier: item.linearIdentifier, title: item.title })
      : (workspaceIntentName?.seedName ?? ''),
    prompt: '',
    linkedIssueNumber: item.type === 'issue' ? (item.number ?? null) : null,
    linkedPR: item.type === 'pr' ? (item.number ?? null) : null
  })
  let resolvedBaseBranch = baseBranch
  let resolvedPushTarget: GitPushTarget | undefined
  let resolvedBranchNameOverride: string | undefined
  if (!resolvedBaseBranch && item.type === 'pr' && item.number) {
    try {
      // Why: direct "Use PR" launches bypass the Start-from picker, so they
      // must still resolve the PR head before `git worktree add`.
      const result = await resolveDirectPrStartPoint(repoId, item.number, settings)
      resolvedBaseBranch = result.baseBranch
      resolvedPushTarget = result.pushTarget
      resolvedBranchNameOverride = result.branchNameOverride
    } catch (error) {
      toast.error(error instanceof Error ? error.message : translate("auto.lib.launch.work.item.direct.8bc45efdbc", "Failed to resolve PR head."))
      openModalFallback()
      return false
    }
  }

  let worktreeId: string
  let primaryTabId: string | null
  let startupPlan: ReturnType<typeof buildAgentStartupPlan> = null
  let effectiveAgent: TuiAgent | null = null
  let draftLaunchedNatively = false
  const draftContent = getDirectDraftContent(item)
  let startupPlanFailed = false
  try {
    const result = await store.createWorktree(
      repoId,
      workspaceName,
      resolvedBaseBranch,
      finalSetupDecision,
      undefined,
      telemetrySource,
      workspaceIntentName?.displayName ?? item.title,
      item.type === 'issue' && item.number ? item.number : undefined,
      item.type === 'pr' && item.number ? item.number : undefined,
      resolvedPushTarget,
      undefined,
      item.linearIdentifier,
      resolvedBranchNameOverride,
      undefined,
      item.type === 'mr' && item.number ? item.number : undefined,
      item.type === 'issue' && item.number && isGitLabIssueUrl(item.url) ? item.number : undefined
    )
    worktreeId = result.worktree.id
    const worktreePath = result.worktree.path

    const createdConnectionId = getConnectionId(worktreeId)
    // Why: newly-created SSH worktrees can be activated before the store
    // rehydrates their repo link; preserve the source repo connection.
    const launchConnectionId = createdConnectionId ?? repoConnectionId
    const launchPlatform =
      args.launchPlatform ??
      resolveSourceControlLaunchPlatform({
        connectionId: launchConnectionId,
        worktreePath
      })
    const latestStore = useAppStore.getState()
    if (agentOverride) {
      const detectedAgents =
        typeof launchConnectionId === 'string'
          ? await latestStore.ensureRemoteDetectedAgents(launchConnectionId)
          : await latestStore.ensureDetectedAgents()
      if (
        !detectedAgents.includes(agentOverride) ||
        !isTuiAgentEnabled(agentOverride, latestStore.settings?.disabledTuiAgents)
      ) {
        activateAndRevealWorktree(worktreeId, {
          sidebarRevealBehavior: 'auto',
          setup: result.setup
        })
        toast.error(translate("auto.lib.launch.work.item.direct.19c7683acf", "Selected agent is not available in the created workspace."))
        return false
      }
      effectiveAgent = agentOverride
    } else {
      const detectedAgents =
        launchConnectionId === repoConnectionId
          ? await detectedAgentsPromise!
          : typeof launchConnectionId === 'string'
            ? await latestStore.ensureRemoteDetectedAgents(launchConnectionId)
            : await latestStore.ensureDetectedAgents()
      const detectedIds = new Set(detectedAgents)
      effectiveAgent = pickTuiAgent(
        settings?.defaultTuiAgent,
        detectedIds,
        settings?.disabledTuiAgents
      )
    }
    if (effectiveAgent) {
      // Why: direct task launch creates and starts the workspace in separate
      // steps so agent detection can overlap git worktree creation. Persist
      // the chosen agent once known so empty-worktree reopen can recreate it.
      void store.updateWorktreeMeta(worktreeId, { createdWithAgent: effectiveAgent }).catch(() => {
        // Non-critical: activation still has the explicit startup below.
      })
    }
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
            workspacePath: worktreePath,
            ...(repo.connectionId ? { connectionId: repo.connectionId } : {})
          })
        } catch {
          // Best-effort: continue with launch even if the trust write
          // throws. The user can dismiss the trust menu manually.
        }
      }
    }

    // Why: draft launches prefer a native prefill flag when the CLI exposes one;
    // submit-after-ready launches must avoid native drafts so Orca can send the
    // generated prompt as the first turn after the TUI is ready.
    const draftLaunchPlan =
      promptDelivery === 'submit-after-ready' || effectiveAgent === null
        ? null
        : buildAgentDraftLaunchPlan({
            agent: effectiveAgent,
            draft: draftContent,
            cmdOverrides: settings?.agentCmdOverrides ?? {},
            platform: launchPlatform,
            agentArgs
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
        platform: launchPlatform,
        agentArgs,
        allowEmptyPromptLaunch: true
      })
      startupPlanFailed = startupPlan === null
    }

    const activation = activateAndRevealWorktree(worktreeId, {
      sidebarRevealBehavior: 'auto',
      setup: result.setup,
      defaultTabs: result.defaultTabs,
      ...buildDirectWorkItemStartupOpts(effectiveAgent, startupPlan, launchSource)
    })
    if (!activation) {
      // Worktree vanished between create and activate — extremely unlikely but
      // worth handling explicitly rather than silently dropping the draft.
      toast.error(translate("auto.lib.launch.work.item.direct.67e103dd60", "Workspace created but could not be activated."))
      return false
    }
    primaryTabId = activation.primaryTabId
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.'
    toast.error(message)
    return false
  }

  store.setSidebarOpen(true)

  if (startupPlanFailed) {
    toast.error(translate("auto.lib.launch.work.item.direct.3de6371df3", "Could not build the agent launch command."))
    return false
  }

  // Why: at this point the workspace is live and the agent (if any) has
  // been queued on `primaryTabId`. The post-launch paste step below only
  // applies to agents that lacked a native prefill flag; for agents that
  // were launched with the draft already on argv (Claude --prefill today),
  // the context is in the input box already — pasting again would duplicate it.
  if (!primaryTabId || !startupPlan || draftLaunchedNatively) {
    return true
  }

  // Why: the workspace is already created and visible; do not block selection
  // latency on agent readiness. Run the paste in the background so the
  // "Use" CTA's spinner ends when the worktree is ready, not when the TUI
  // input buffer is ready.
  void pasteDirectWorkItemDraftWhenAgentReady({
    primaryTabId,
    startupPlan,
    content: draftContent,
    submit: promptDelivery === 'submit-after-ready',
    forcePaste: promptDelivery === 'submit-after-ready'
  })
  return true
}
