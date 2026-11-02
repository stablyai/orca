/** The terminal plan a new workspace's own planner sends for a local, out-of-view Codex launch whose
 *  composer left only an unsent draft (a linked issue's context). The window's test pins its real
 *  planner to this exact output; the host's test runs it, so both sides prove one plan. */

import type { AgentLaunchTerminalStartupParams } from './agent-launch-accept-params'

export const CODEX_PLANNED_DRAFT = 'Review https://github.com/o/r/issues/12 before sending'

export const CODEX_DRAFT_ONLY_TERMINAL_STARTUP = {
  kind: 'command',
  command: "codex '-c' 'disable_paste_burst=true' '--dangerously-bypass-approvals-and-sandbox'",
  env: {},
  launchConfig: {
    agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
    agentArgs: '--dangerously-bypass-approvals-and-sandbox',
    agentEnv: {}
  },
  draftPrompt: CODEX_PLANNED_DRAFT,
  prompt: 'none'
} as const satisfies AgentLaunchTerminalStartupParams
