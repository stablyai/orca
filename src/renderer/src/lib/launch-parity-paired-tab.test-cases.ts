// Test-only: the row 7 parity table (typed prompt into a new tab on a paired web host). The
// producer suite asserts launchAgentInNewTab hands each creator `launch`; the wire suite feeds
// the same `launch` to the real creator and pins the RPC the host receives.
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab'
import type { CreateWebRuntimeSessionTerminalArgs } from '@/runtime/web-runtime-session-types'
import {
  launchWorkspaceId,
  type LaunchWorkspace
} from '../../../shared/launch-parity-window-request.test-fixture'
import { PAIRED_TAB_PATH } from '../../../shared/launch-parity-paired-host.test-fixture'

// The wire suite's paired environment (web-runtime-session-test-harness.ts ENVIRONMENT_ID).
const ENVIRONMENT_ID = 'web-env-1'
/** The paired worktree every row 7 case launches into. */
export const PAIRED_WORKSPACE: LaunchWorkspace = {
  kind: 'repo',
  path: PAIRED_TAB_PATH,
  pairedRuntime: ENVIRONMENT_ID
}
const WORKTREE_ID = launchWorkspaceId(PAIRED_WORKSPACE)

export type PairedTabCase = {
  name: string
  producer: Pick<LaunchAgentInNewTabArgs, 'agent' | 'prompt'> &
    Partial<Pick<LaunchAgentInNewTabArgs, 'promptDelivery' | 'agentArgs' | 'initialCwd'>>
} & (
  | { creator: 'session'; launch: CreateWebRuntimeSessionTerminalArgs }
  | {
      creator: 'launch-draft'
      launch: CreateWebRuntimeSessionTerminalArgs & { agent: 'claude'; launchDraft: string }
    }
)

const BASE = {
  worktreeId: WORKTREE_ID,
  environmentId: ENVIRONMENT_ID,
  targetGroupId: 'group-1',
  activate: true,
  viewMode: 'terminal',
  agentSessionKind: 'fresh'
} as const
const CODEX_ARGS = '--dangerously-bypass-approvals-and-sandbox'
const codex = (agentArgs = CODEX_ARGS): CreateWebRuntimeSessionTerminalArgs => ({
  ...BASE,
  launchAgent: 'codex',
  command: `codex '${agentArgs.split(' ').join("' '")}' 'fix it'`,
  env: {},
  launchConfig: {
    agentCommand: `codex '${agentArgs.split(' ').join("' '")}'`,
    agentArgs,
    agentEnv: {}
  },
  startupCommandDelivery: 'shell-ready',
  prompt: 'fix it',
  promptDelivery: 'auto-submit'
})

// A Claude draft rides --prefill on the launch command, through the launch-draft creator.
const CLAUDE_DRAFT = {
  ...BASE,
  launchAgent: 'claude',
  command: `claude '--dangerously-skip-permissions' --prefill 'review Bob'"'"'s change'`,
  env: {},
  launchConfig: {
    agentCommand: "claude '--dangerously-skip-permissions'",
    agentArgs: '--dangerously-skip-permissions',
    agentEnv: {}
  },
  prompt: "review Bob's change",
  promptDelivery: 'draft',
  agent: 'claude',
  launchDraft: "review Bob's change"
} as const
const claudeDraft = {
  agent: 'claude',
  prompt: "  review Bob's change  ",
  promptDelivery: 'draft'
} as const

export const PAIRED_TAB_CASES: PairedTabCase[] = [
  // Session fork: a Claude draft.
  { name: 'claude draft', producer: claudeDraft, creator: 'launch-draft', launch: CLAUDE_DRAFT },
  {
    // Session continuation: Claude always gets a draft, with the session's cwd.
    name: 'claude draft continuation, initial cwd',
    producer: { ...claudeDraft, initialCwd: `${PAIRED_TAB_PATH}/packages/app` },
    creator: 'launch-draft',
    launch: { ...CLAUDE_DRAFT, cwd: `${PAIRED_TAB_PATH}/packages/app` }
  },
  {
    name: 'codex auto-submit',
    producer: { agent: 'codex', prompt: 'fix it' },
    creator: 'session',
    launch: codex()
  },
  {
    // An explicit caller agentArgs replaces the default args and rides on the launch as-is.
    name: 'codex auto-submit, caller agentArgs',
    producer: { agent: 'codex', prompt: 'fix it', agentArgs: '--model gpt-5' },
    creator: 'session',
    launch: { ...codex('--model gpt-5'), agentArgs: '--model gpt-5' }
  }
]
