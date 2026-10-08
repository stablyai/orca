import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { ACTIVE_CLAUDE_ACCOUNT } from '../../../shared/claude/project-claude-account-preference'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'

/**
 * One profile per production call site of the shared agent-launch funnel.
 *
 * The suite feeds these argument shapes through the real funnel instead of driving twelve caller
 * module graphs: a migration rewrites the funnel's internals, not what a caller hands it, so the
 * observable outcome of each caller's argument shape is the thing that must survive.
 */
/** Each call site mints its own request id, so a profile carries none. */
export type CallerLaunchArgs = Omit<
  LaunchAgentInNewTabArgs,
  'beforeSurfaceOpen' | 'agentSessionLaunchPlan' | 'onPromptDelivered' | 'requestId'
>

export type AgentLaunchCallerProfile = {
  /** Production module that owns this call site. */
  caller: string
  /** Stable id used in test titles so a dropped profile is visible in the report. */
  id: string
  /**
   * The argument object this call site builds. Values the call site derives at runtime (agent,
   * workspace, prompt text, group) use a representative stand-in; values it fixes as a literal are
   * reproduced exactly.
   */
  args: CallerLaunchArgs
}

const PROMPT = 'Explain the failing check and propose a fix.'

export const AGENT_LAUNCH_CALLER_PROFILES: readonly AgentLaunchCallerProfile[] = [
  {
    id: 'dashboard-spawn',
    caller: 'src/renderer/src/components/dashboard/launch-dashboard-agent.ts',
    args: { agent: 'codex', worktreeId: 'wt-1', launchSource: 'unknown' }
  },
  {
    id: 'empty-workspace-default-chat',
    caller: 'src/renderer/src/lib/empty-workspace-default-agent-chat.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      launchSource: 'unknown',
      pendingActivationSpawn: true
    }
  },
  {
    id: 'floating-default-agent',
    caller: 'src/renderer/src/components/floating-terminal/FloatingTerminalWindowControls.tsx',
    args: {
      agent: 'codex',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'shortcut'
    }
  },
  {
    id: 'source-control-action',
    caller: 'src/renderer/src/components/right-sidebar/runSourceControlAgentActionStart.ts',
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
    }
  },
  {
    id: 'source-control-recovery',
    caller: 'src/renderer/src/components/right-sidebar/source-control/ai/recovery-launch.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      agentArgs: '--model gpt-5.5',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      launchSource: 'source_control_recovery'
    }
  },
  {
    id: 'git-history-explain-commit',
    caller:
      'src/renderer/src/components/right-sidebar/source-control/sync/use-git-history-commit-actions.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready'
    }
  },
  {
    id: 'tab-bar-quick-launch-button',
    caller: 'src/renderer/src/components/tab-bar/QuickLaunchButton.tsx',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      launchSource: 'tab_bar_quick_launch'
    }
  },
  {
    id: 'tab-bar-create-menu',
    caller: 'src/renderer/src/components/tab-bar/use-tab-bar-create-menu-controller.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      launchSource: 'tab_bar_quick_launch'
    }
  },
  {
    id: 'terminal-session-fork',
    caller: 'src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'draft',
      launchSource: 'terminal_context_menu',
      launchPlatform: 'darwin'
    }
  },
  {
    id: 'terminal-pane-start-on-active-account',
    caller: 'src/renderer/src/components/terminal-pane/TerminalPaneSurface.tsx',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      claudeAccountId: ACTIVE_CLAUDE_ACCOUNT,
      launchSource: 'unknown'
    }
  },
  {
    id: 'terminal-create-shortcut',
    caller: 'src/renderer/src/components/use-terminal-create-actions.ts',
    args: { agent: 'codex', worktreeId: 'wt-1', groupId: 'group-1', launchSource: 'shortcut' }
  },
  {
    id: 'fix-checks',
    caller: 'src/renderer/src/lib/fix-checks-agent-launch.ts',
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
    }
  },
  {
    id: 'session-continuation',
    caller: 'src/renderer/src/lib/launch-agent-session-continuation.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      initialCwd: '/repo/worktree/packages/app',
      // Caller-supplied, not fixed at the call site: one representative value stands in.
      launchSource: 'command_palette'
    }
  },
  {
    id: 'quick-command',
    caller: 'src/renderer/src/lib/run-quick-command-in-new-tab.ts',
    args: {
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: PROMPT,
      launchSource: 'quick_command',
      quickCommandLabel: 'Review'
    }
  }
]

/** The profile table shaped for `it.each`, so every test title names the call site it covers. */
export function callerProfileCases(): [string, AgentLaunchCallerProfile][] {
  return AGENT_LAUNCH_CALLER_PROFILES.map((profile) => [profile.id, profile])
}
