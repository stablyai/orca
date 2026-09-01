import { useAppStore } from '@/store'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from '@/lib/agent-launch-prompt-delivery'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { seedCommandCodeSubmittedPromptStatus } from '@/lib/command-code-prompt-status-seed'
import type { TuiAgent } from '../../../shared/types'
import type {
  AgentLaunchSourceRecord,
  AgentLaunchSpawnRequest
} from '../../../shared/agent-launch-spawn-request'
import type { LaunchSource } from '../../../shared/telemetry-events'
import { getConnectionIdFromState } from '@/lib/connection-context'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Host-verified saved owner (e.g. a source-control recipe) whose stored
   *  agentArgs/env the host resolves and applies to this launch. Clients send
   *  only the locator; the host owns all command/arg assembly. */
  sourceRecord?: AgentLaunchSourceRecord
  /** Unsaved edits of the sourceRecord recipe's agentArgs, applied to this launch
   *  instead of the stored ones. Best-effort: a host predating the field launches
   *  the stored args, so never report these as applied. */
  unsavedAgentArgs?: string
  /** Optional working directory for the new terminal session. */
  initialCwd?: string | null
  /** Force generated prompt text out of the shell launch command. `draft`
   *  leaves it editable; `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Vestigial: the host now owns platform-dependent command assembly, so this
   *  no longer affects the client launch. Still accepted so the source-control
   *  callers that thread it need not change; retiring that threading is a
   *  follow-up cleanup. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
}

export type LaunchAgentInNewTabResult = {
  tabId: string | null
  pasteDraftAfterLaunch: boolean
  /** The host will publish and focus a structured tab asynchronously. */
  focusAfterMenuClose?: 'structured-session'
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
}

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.tabId === null && result.focusAfterMenuClose !== 'structured-session'
}

/**
 * Create a new terminal tab and queue the agent's launch command, optionally
 * with an initial prompt.
 *
 * Default submission mode follows `promptInjectionMode`: argv/flag agents
 * include the prompt directly in the launch command, while followup-path
 * agents launch empty and receive a post-ready draft paste. Generated contexts
 * can override this with draft or submit-after-ready delivery.
 *
 * The host owns command/arg/token assembly on the `agentLaunch` path, so this
 * never validates or aborts on the client: an unlaunchable request (e.g.
 * untokenizable stored args) still creates the tab and surfaces the host's
 * typed failure downstream rather than silently no-op'ing.
 */
export function launchAgentInNewTab(args: LaunchAgentInNewTabArgs): LaunchAgentInNewTabResult {
  const {
    agent,
    worktreeId,
    groupId,
    prompt,
    sourceRecord,
    unsavedAgentArgs,
    initialCwd,
    promptDelivery = 'auto-submit',
    launchSource,
    quickCommandLabel,
    onPromptDelivered
  } = args
  const store = useAppStore.getState()
  const worktree = store.allWorktrees?.().find((entry: { id: string }) => entry.id === worktreeId)
  const repo = worktree ? store.repos?.find((entry) => entry.id === worktree.repoId) : null
  // Why: on a remote (SSH/relay) target the host delivers a post-ready draft
  // through its local ptyController, which never reaches the relay-hosted pty
  // (the W6-remote U10 gap). A folded draft the host defers to post-ready would
  // be silently lost there, so the draft branch below routes to a client-side
  // paste on remote instead.
  const isRemote = repo ? repoIsRemote(repo) : false
  const trimmedPrompt = prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  // Why: key the fold-vs-paste decision on the resolved BASE agent. Under
  // noImplicitAny:false a custom id would index TUI_AGENT_CONFIG as `any`,
  // reading promptInjectionMode as undefined and silently folding a
  // stdin-after-start base into argv instead of pasting after start. A custom
  // id inherits its base's injection mode; an unresolvable id is unlaunchable
  // downstream, so treat it as non-followup here.
  const baseAgent = resolveTuiAgentBaseAgent(
    agent,
    store.settings?.customTuiAgents,
    store.settings?.deletedCustomTuiAgents
  )
  const isFollowupPath =
    baseAgent !== null && TUI_AGENT_CONFIG[baseAgent].promptInjectionMode === 'stdin-after-start'
  // Why: argv/flag agents fold the prompt into the launch command and
  // auto-submit — keeping behavior consistent with the composer/tab-bar `+`
  // mental model, where the prompt is "the first turn the user sent".
  // Followup-path and generated-context launches can deliver a prompt via
  // post-launch bracketed paste; callers decide whether that paste remains a
  // draft or submits after readiness.
  // The host assembles and validates the launch; the client only decides
  // whether the prompt folds into that launch or is pasted after readiness.
  let pasteDraftAfterLaunch: string | null = null
  let submitPastedPrompt = false
  let forcePasteAfterLaunch = false
  let promptDeliveryResult: Promise<{ delivered: boolean; failureNotified: boolean }> | undefined

  if (hasPrompt && promptDelivery === 'submit-after-ready') {
    // Why: generated multi-line prompts are too large to echo through a shell
    // argv/prefill command. Launch cleanly, then paste+submit inside the TUI.
    pasteDraftAfterLaunch = trimmedPrompt
    submitPastedPrompt = true
    forcePasteAfterLaunch = true
  } else if (hasPrompt && promptDelivery === 'draft') {
    // Local: fold the draft into the host launch (pasteDraftAfterLaunch stays
    // null). The host owns whether it lands via an inline flag, an env var, or a
    // post-ready draftPrompt paste (draftParts/maxInlineDraftChars) — no client
    // command estimate. Remote: the host's post-ready draftPrompt paste writes
    // through its local ptyController and never reaches the relay-hosted pty
    // (W6-remote U10 gap), so a folded draft the host defers to post-ready would
    // be silently lost. Deliver via a client paste instead — the same text
    // arrives; forcePaste overrides the native-prefill no-op so a
    // draftPromptFlag/env base still receives it (nothing was folded to prefill).
    if (isRemote) {
      pasteDraftAfterLaunch = trimmedPrompt
      forcePasteAfterLaunch = true
    }
  } else if (hasPrompt && isFollowupPath) {
    pasteDraftAfterLaunch = trimmedPrompt
  }

  // Why: the prompt rides `agentLaunch` only when it folds into the launch
  // itself (argv/flag agents, native draft flag). Every post-ready paste path
  // (submit-after-ready, oversized draft, stdin-after-start followup) launches
  // bare and the renderer delivers the prompt below, so the request carries
  // `allowEmptyPromptLaunch` instead. A native draft fold must stay UNSUBMITTED,
  // so forward `promptDelivery: 'draft'` — without it the host defaults to
  // submit and auto-sends the draft.
  const promptFoldsIntoLaunch = pasteDraftAfterLaunch === null && hasPrompt
  const agentLaunch: AgentLaunchSpawnRequest = {
    selection: { kind: 'agent', agent },
    ...(promptFoldsIntoLaunch
      ? {
          prompt: trimmedPrompt,
          ...(promptDelivery === 'draft' ? { promptDelivery: 'draft' as const } : {})
        }
      : { allowEmptyPromptLaunch: true }),
    // Why: recipe-driven launches name the saved owner so the host resolves and
    // applies its stored agentArgs (and env) itself. Unsaved arg edits ride along
    // as text the host substitutes for that stored snapshot — never assembled argv
    // — and only make sense with the owner locator that scopes them.
    ...(sourceRecord
      ? {
          sourceRecord,
          ...(unsavedAgentArgs !== undefined ? { unsavedAgentArgs } : {})
        }
      : {})
  }

  // Why: the remote host can't infer this client's draft/default view choice, so decide it here for paired tabs too.
  const viewModePromptDelivery =
    hasPrompt && isFollowupPath && promptDelivery === 'auto-submit' ? 'draft' : promptDelivery
  const initialViewModeArgs = {
    agent,
    promptDelivery: viewModePromptDelivery,
    launchDraftText: trimmedPrompt,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      getConnectionIdFromState(store, worktreeId)
    )
  }
  const initialViewModeProps = initialAgentTabViewModeProps(store.settings, initialViewModeArgs)
  // Why: session options stay client-owned even though the host assembles the
  // command — they configure the native-chat pane (model, reasoning effort), not
  // the startup argv, so the agentLaunch boundary never carries them.
  const sessionOptions = resolveInitialNativeChatSessionOptions(store.settings, initialViewModeArgs)

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    const webHostDelivery = launchAgentInWebHostTab({
      // Why: route the paired-web launch through the same host `agentLaunch`
      // boundary as the local path — the host owns command/config/token assembly,
      // so the client never sends an assembled startup plan here (the last
      // client-assembled launch on this surface).
      agent,
      worktreeId,
      environmentId: runtimeEnvironmentId,
      groupId,
      cwd: initialCwd,
      hasPrompt,
      agentLaunch,
      ...(pasteDraftAfterLaunch !== null
        ? {
            promptAfterReady: {
              content: pasteDraftAfterLaunch,
              submit: submitPastedPrompt,
              forcePaste: forcePasteAfterLaunch
            }
          }
        : {}),
      // Why: omission means terminal locally, but would let a paired host apply
      // its own default; send the client's resolved terminal choice explicitly.
      viewMode: initialViewModeProps.viewMode ?? 'terminal',
      onPromptDelivered
    })
    return {
      tabId: null,
      pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
      ...(pasteDraftAfterLaunch !== null && promptDelivery === 'submit-after-ready'
        ? { promptDeliveryResult: webHostDelivery }
        : {})
    }
  }

  const launchDirectStructuredChat =
    agent === 'codex' &&
    !hasPrompt &&
    store.settings?.experimentalNativeChat === true &&
    canUseStructuredNativeChat(store, worktreeId)
  if (launchDirectStructuredChat) {
    startStructuredCodexLaunch(worktreeId)
    return {
      tabId: null,
      startupPlan,
      pasteDraftAfterLaunch: false,
      focusAfterMenuClose: 'structured-session'
    }
  }

  // Why: queue startup BEFORE TerminalPane mounts — it snapshots pendingStartupByTabId in useState on first render.
  // Why: followup path pastes an unsubmitted draft, so gate the initial chat view like a draft launch, not auto-submit.
  const tab = store.createTab(worktreeId, groupId, undefined, {
    launchAgent: agent,
    quickCommandLabel,
    ...initialViewModeProps
  })
  seedNativeChatAppliedSessionOptions(tab.id, agent, sessionOptions)
  if (initialCwd?.trim()) {
    // Why: queue before mount so local, WSL, and SSH continuations preserve their subdirectory.
    store.queueTabInitialCwd(tab.id, initialCwd)
  }
  store.queueTabStartupCommand(tab.id, {
    // The host owns command/config/token assembly on the agentLaunch path; the
    // client only names the requested identity and prompt/launch policy.
    command: '',
    agentLaunch,
    ...(sessionOptions ? { sessionOptions } : {}),
    // Why: gate on the resolved BASE — a command-code-based custom agent has the
    // same missing prompt-start hook. The status keeps the REQUESTED id so the
    // pane stays attributed to the custom agent the user launched.
    ...(baseAgent === 'command-code' && hasPrompt && promptDelivery === 'auto-submit'
      ? { initialAgentStatus: { agent, prompt: trimmedPrompt } }
      : {}),
    // Host overwrites agent_kind from the resolved receipt before the emit, so
    // this host-resolved launch threads only the surface-owned fields.
    telemetry: {
      launch_source: launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    }
  })
  if (hasPrompt && promptDelivery === 'draft' && pasteDraftAfterLaunch === null) {
    // Why: the draft rides in through the host launch, so no renderer paste
    // seeds the mirrored chat composer.
    seedNativeChatLaunchDraftForAgentTab({ tabId: tab.id, agent, text: trimmedPrompt })
  }
  // Why: schedule the bracketed-paste-after-ready follow-up immediately after
  // the startup command is queued. Fire-and-forget so callers stay synchronous.
  if (pasteDraftAfterLaunch !== null) {
    const timeoutNotice = createPasteReadinessTimeoutNotice({
      worktreeId,
      tabId: tab.id,
      agent,
      submitted: submitPastedPrompt
    })
    const deliveryPromise = deliverLaunchPromptToAgentTab({
      tabId: tab.id,
      content: pasteDraftAfterLaunch,
      agent,
      submit: submitPastedPrompt,
      forcePaste: forcePasteAfterLaunch,
      onTimeout: timeoutNotice.onTimeout
    }).then((delivered) => {
      if (delivered) {
        if (baseAgent === 'command-code' && submitPastedPrompt) {
          // Why: Command Code has no prompt-submit hook; when Orca submits a
          // generated prompt after readiness, seed working at delivery time.
          seedCommandCodeSubmittedPromptStatus(worktreeId, tab.id, agent, trimmedPrompt)
        }
        onPromptDelivered?.()
      }
      return { delivered, failureNotified: !delivered && timeoutNotice.wasNotified() }
    })
    if (promptDelivery === 'submit-after-ready') {
      promptDeliveryResult = deliveryPromise
    } else {
      void deliveryPromise.catch((error) =>
        console.error('Prompt delivery failed after launch', error)
      )
    }
  } else if (hasPrompt) {
    onPromptDelivered?.()
  }

  // Why: without setActiveTabType('terminal') a worktree showing an editor keeps rendering it and the new tab stays hidden.
  store.setActiveTabType('terminal')

  // Why: persist tab-bar order so reconcileTabOrder doesn't fall back to terminals-first and jump the new tab to index 0.
  const fresh = useAppStore.getState()
  const termIds = (fresh.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = fresh.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (fresh.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const base = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(worktreeId, order)

  return {
    tabId: tab.id,
    pasteDraftAfterLaunch: pasteDraftAfterLaunch !== null,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {})
  }
}
