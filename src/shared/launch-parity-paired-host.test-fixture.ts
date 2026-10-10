// Test-only (never imported by production code): what a paired host receives for rows 5r
// (automations) and 7 (typed-prompt new tabs). Renderer suites assert the real creators send these
// params; the main suite runs them through the host's RPC method handlers.
import {
  AUTOMATION_COMMANDS,
  AUTOMATION_PROMPT,
  automationSpawnRequest,
  type AutomationLaunchCase
} from './launch-parity-automation-cases.test-fixture'
import {
  LAUNCH_LEAF_ID,
  LAUNCH_TAB_ID,
  launchWorkspaceId,
  type LaunchClient,
  type LaunchWorkspace
} from './launch-parity-window-request.test-fixture'
import { POSIX_PATH } from './launch-parity-window-cases.test-fixture'

/** Row 5r: an automation in a worktree a paired runtime (env-1) owns. */
export type PairedAutomationCase = {
  name: string
  client: LaunchClient
  agent: AutomationLaunchCase['agent']
  /** Whether the host advertises the agent-session keyboard capability. */
  keyboard: boolean
}
export const PAIRED_AUTOMATION_WORKSPACE: LaunchWorkspace = {
  kind: 'repo',
  path: POSIX_PATH,
  pairedRuntime: 'env-1'
}
const PAIRED_TITLE = 'Nightly audit run 3'

// The window plan is quoted for the OS the paired host reports (Linux), not the Windows client's.
export const PAIRED_AUTOMATION_FROM_WINDOWS: PairedAutomationCase = {
  name: 'claude from a Windows client',
  client: 'win32',
  agent: 'claude',
  keyboard: true
}

export const PAIRED_AUTOMATION_CASES: PairedAutomationCase[] = [
  { name: 'claude', client: 'linux', agent: 'claude', keyboard: true },
  { name: 'claude, keyboard not negotiated', client: 'linux', agent: 'claude', keyboard: false },
  // The window plan's shell-ready delivery for codex is not sent; the host re-plans.
  { name: 'codex', client: 'linux', agent: 'codex', keyboard: true },
  // stdin-after-start: the client pastes the prompt after the host creates the terminal.
  { name: 'aider sends no prompt', client: 'linux', agent: 'aider', keyboard: true },
  PAIRED_AUTOMATION_FROM_WINDOWS
]

/** terminal.createAgentSession params for a host with agent-session host authority. */
export function pairedAgentSessionParams(c: PairedAutomationCase): Record<string, unknown> {
  // main today: no command, env, launchConfig, launchToken, title or agentArgs cross the wire.
  return {
    ...(c.keyboard ? { terminalKittyKeyboardProtocol: true } : {}),
    worktree: `id:${launchWorkspaceId(PAIRED_AUTOMATION_WORKSPACE)}`,
    agent: c.agent,
    ...(c.agent === 'aider' ? {} : { prompt: AUTOMATION_PROMPT, promptDelivery: 'auto-submit' }),
    placement: { tabId: LAUNCH_TAB_ID, leafId: LAUNCH_LEAF_ID },
    presentation: 'background'
  }
}

/** terminal.create params for a host without it: the window plan, verbatim. */
export function pairedLegacyCreateParams(c: PairedAutomationCase): Record<string, unknown> {
  const quoted = c.agent === 'claude' ? AUTOMATION_COMMANDS.posix : AUTOMATION_COMMANDS[c.agent]
  const { command, env, launchConfig, launchToken, launchAgent, tabId, leafId } =
    automationSpawnRequest({
      name: c.name,
      client: c.client,
      agent: c.agent,
      title: PAIRED_TITLE,
      workspace: PAIRED_AUTOMATION_WORKSPACE,
      request: quoted,
      provider: { shellOverride: undefined }
    })
  // No telemetry, cwd, placement or connection: the host owns them; kitty is never negotiated here.
  return {
    worktree: `id:${launchWorkspaceId(PAIRED_AUTOMATION_WORKSPACE)}`,
    command,
    terminalKittyKeyboardProtocol: true,
    ...(c.agent === 'codex' ? { startupCommandDelivery: 'shell-ready' } : {}),
    env,
    launchConfig,
    launchToken,
    launchAgent,
    title: PAIRED_TITLE,
    tabId,
    leafId,
    presentation: 'background'
  }
}

// Row 7: terminal.createAgentSession params per launch-parity-paired-tab.test-cases.ts case.
export const PAIRED_TAB_PATH = '/worktree'
const CODEX_ARGS = '--dangerously-bypass-approvals-and-sandbox'
const base = {
  worktree: `id:repo-1::${PAIRED_TAB_PATH}`,
  viewMode: 'terminal',
  presentation: 'background'
} as const
const claudeDraft = {
  ...base,
  agent: 'claude',
  prompt: "review Bob's change",
  promptDelivery: 'draft',
  agentArgs: '--dangerously-skip-permissions'
} as const
const codex = { ...base, agent: 'codex', prompt: 'fix it', promptDelivery: 'auto-submit' } as const

// main today: command, env, launchConfig and startupCommandDelivery never reach the host; agentArgs
// is the caller's override, else the window's default args.
export const PAIRED_TAB_HOST_PARAMS: Record<string, Record<string, unknown>> = {
  'claude draft': claudeDraft,
  'claude draft continuation, initial cwd': {
    ...claudeDraft,
    startupCwd: `${PAIRED_TAB_PATH}/packages/app`
  },
  'codex auto-submit': { ...codex, agentArgs: CODEX_ARGS },
  'codex auto-submit, caller agentArgs': { ...codex, agentArgs: '--model gpt-5' }
}
