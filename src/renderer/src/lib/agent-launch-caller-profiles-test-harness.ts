import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'

/**
 * One profile per production call site of the shared agent-launch funnel.
 *
 * The suite feeds these argument shapes through the real funnel instead of driving twelve caller
 * module graphs: a migration rewrites the funnel's internals, not what a caller hands it, so the
 * observable outcome of each caller's argument shape is the thing that must survive.
 *
 * `sourceMarkers` re-anchors each profile to its call site. A caller that stops passing what the
 * profile encodes fails the census rather than silently drifting out of coverage.
 */
export type CallerLaunchArgs = Omit<
  LaunchAgentInNewTabArgs,
  'beforeSurfaceOpen' | 'agentSessionLaunchPlan' | 'onPromptDelivered'
>

export type CallerResultRead =
  | 'surface-tab-id'
  | 'prompt-delivery-result'
  | 'null-only'
  | 'discarded'

export type AgentLaunchCallerProfile = {
  /** Production module that owns this call site. */
  caller: string
  /** Stable id used in test titles so a dropped profile is visible in the report. */
  id: string
  /** Literal fragments the call site must still contain for this profile to be current. */
  sourceMarkers: readonly string[]
  /**
   * The argument object this call site builds. Values the call site derives at runtime (agent,
   * workspace, prompt text, group) use a representative stand-in; values it fixes as a literal are
   * reproduced exactly.
   */
  args: CallerLaunchArgs
  /** The call site installs a `beforeSurfaceOpen` hook. */
  passesBeforeSurfaceOpen: boolean
  /** The call site hands in a route plan preflighted before the workspace existed. */
  passesLaunchPlan: boolean
  /** The call site installs an `onPromptDelivered` callback. */
  passesOnPromptDelivered: boolean
  /** What the call site reads off the synchronous result. */
  readsBack: readonly CallerResultRead[]
}

const PROMPT = 'Explain the failing check and propose a fix.'

export const AGENT_LAUNCH_CALLER_PROFILES: readonly AgentLaunchCallerProfile[] = [
  {
    id: 'dashboard-spawn',
    caller: 'src/renderer/src/components/dashboard/launch-dashboard-agent.ts',
    sourceMarkers: ["launchSource: 'unknown'"],
    args: { agent: 'codex', worktreeId: 'wt-1', launchSource: 'unknown' },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['null-only']
  },
  {
    id: 'floating-default-agent',
    caller: 'src/renderer/src/components/floating-terminal/FloatingTerminalWindowControls.tsx',
    sourceMarkers: [
      'worktreeId: FLOATING_TERMINAL_WORKTREE_ID',
      "launchSource: 'shortcut'",
      'activate: false'
    ],
    args: {
      agent: 'codex',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'shortcut',
      activate: false
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['surface-tab-id']
  },
  {
    id: 'source-control-action',
    caller: 'src/renderer/src/components/right-sidebar/runSourceControlAgentActionStart.ts',
    sourceMarkers: [
      'groupId: groupId ?? worktreeId',
      'agentArgs: launchAgentArgs',
      'promptDelivery,',
      'launchPlatform,'
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      // Caller-supplied, not fixed at the call site: one representative value stands in.
      launchSource: 'sidebar'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['surface-tab-id', 'prompt-delivery-result']
  },
  {
    id: 'source-control-recovery',
    caller: 'src/renderer/src/components/right-sidebar/source-control/ai/recovery-launch.ts',
    sourceMarkers: [
      'groupId: activeGroupId ?? activeWorktreeId',
      'agentArgs: savedRecipe.agentArgs',
      "promptDelivery: 'submit-after-ready'",
      "launchSource: 'source_control_recovery'"
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      launchSource: 'source_control_recovery'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['surface-tab-id']
  },
  {
    id: 'git-history-explain-commit',
    caller:
      'src/renderer/src/components/right-sidebar/source-control/sync/use-git-history-commit-actions.ts',
    sourceMarkers: ['prompt: explainPrompt', "promptDelivery: 'submit-after-ready'"],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['discarded']
  },
  {
    id: 'tab-bar-quick-launch-button',
    caller: 'src/renderer/src/components/tab-bar/QuickLaunchButton.tsx',
    sourceMarkers: [
      '...(prompt !== undefined ? { prompt } : {})',
      '...(promptDelivery !== undefined ? { promptDelivery } : {})',
      '...(onPromptDelivered !== undefined ? { onPromptDelivered } : {})'
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      launchSource: 'tab_bar_quick_launch'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: true,
    readsBack: ['surface-tab-id']
  },
  {
    id: 'tab-bar-create-menu',
    caller: 'src/renderer/src/components/tab-bar/use-tab-bar-create-menu-controller.ts',
    sourceMarkers: ['groupId: resolvedGroupId', "launchSource: 'tab_bar_quick_launch'"],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      launchSource: 'tab_bar_quick_launch'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['surface-tab-id']
  },
  {
    id: 'terminal-session-fork',
    caller: 'src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts',
    sourceMarkers: [
      "promptDelivery: 'draft'",
      "launchSource: 'terminal_context_menu'",
      'agentSessionLaunchPlan,',
      'beforeSurfaceOpen: (surface) =>'
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'draft',
      launchSource: 'terminal_context_menu',
      launchPlatform: 'darwin'
    },
    passesBeforeSurfaceOpen: true,
    passesLaunchPlan: true,
    passesOnPromptDelivered: false,
    readsBack: ['null-only']
  },
  {
    id: 'terminal-pane-start-on-active-account',
    caller: 'src/renderer/src/components/terminal-pane/TerminalPaneSurface.tsx',
    // `args.agent` is the table's normalized stand-in (see the type doc); the marker anchors the real 'claude'.
    sourceMarkers: ["agent: 'claude'", 'claudeAccountId: ACTIVE_CLAUDE_ACCOUNT'],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      claudeAccountId: ACTIVE_CLAUDE_ACCOUNT,
      launchSource: 'unknown'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['discarded']
  },
  {
    id: 'terminal-create-shortcut',
    caller: 'src/renderer/src/components/use-terminal-create-actions.ts',
    sourceMarkers: ['groupId: targetGroupId', "launchSource: 'shortcut'"],
    args: { agent: 'codex', worktreeId: 'wt-1', groupId: 'group-1', launchSource: 'shortcut' },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['null-only']
  },
  {
    id: 'fix-checks',
    caller: 'src/renderer/src/lib/fix-checks-agent-launch.ts',
    sourceMarkers: [
      'agentArgs: recipe.agentArgs',
      "promptDelivery: 'submit-after-ready'",
      'beforeSurfaceOpen: () => {'
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      // Caller-supplied, not fixed at the call site: one representative value stands in.
      launchSource: 'task_page'
    },
    passesBeforeSurfaceOpen: true,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['surface-tab-id']
  },
  {
    id: 'session-continuation',
    caller: 'src/renderer/src/lib/launch-agent-session-continuation.ts',
    sourceMarkers: [
      "promptDelivery: agent === 'claude' ? 'draft' : 'submit-after-ready'",
      'onPromptDelivered: () =>'
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      initialCwd: '/repo/worktree/packages/app',
      // Caller-supplied, not fixed at the call site: one representative value stands in.
      launchSource: 'command_palette'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: true,
    readsBack: ['prompt-delivery-result']
  },
  {
    id: 'quick-command',
    caller: 'src/renderer/src/lib/run-quick-command-in-new-tab.ts',
    sourceMarkers: [
      "launchSource: 'quick_command'",
      'quickCommandLabel: command.label',
      "{ promptDelivery: 'submit-after-ready' as const }"
    ],
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    },
    passesBeforeSurfaceOpen: false,
    passesLaunchPlan: false,
    passesOnPromptDelivered: false,
    readsBack: ['surface-tab-id']
  }
]

/** The profile table shaped for `it.each`, so every test title names the call site it covers. */
export function callerProfileCases(): [string, AgentLaunchCallerProfile][] {
  return AGENT_LAUNCH_CALLER_PROFILES.map((profile) => [profile.id, profile])
}
