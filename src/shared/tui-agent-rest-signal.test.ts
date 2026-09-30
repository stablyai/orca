import { describe, expect, it } from 'vitest'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { getTuiAgentRestSignal, type TuiAgentRestSignal } from './tui-agent-rest-signal'

// Why a full Record: adding a TuiAgent fails to compile here until someone decides what its
// rest signal is, and a title-table change that moves an agent shows up in review.
const EXPECTED_REST_SIGNALS: Record<TuiAgent, TuiAgentRestSignal> = {
  dsh: 'hook-done',
  codex: 'synthetic-title',
  cursor: 'synthetic-title',
  pi: 'synthetic-title',
  omp: 'synthetic-title',
  droid: 'synthetic-title',
  hermes: 'synthetic-title',
  devin: 'synthetic-title',
  zcode: 'synthetic-title',
  claude: 'title',
  'claude-agent-teams': 'title',
  openclaude: 'title',
  opencode: 'title',
  opencode2: 'title',
  'mimo-code': 'title',
  gemini: 'title',
  antigravity: 'title',
  aider: 'title',
  openclaw: 'title',
  copilot: 'title',
  grok: 'title',
  muse: 'ready-body',
  qoder: 'ready-body',
  codebuddy: 'none',
  autohand: 'none',
  ante: 'none',
  trae: 'none',
  'prime-agent': 'none',
  goose: 'none',
  amp: 'none',
  kilo: 'none',
  kiro: 'synthetic-title',
  crush: 'none',
  aug: 'none',
  cline: 'none',
  codebuff: 'none',
  freebuff: 'none',
  'command-code': 'none',
  continue: 'none',
  kimi: 'none',
  'mistral-vibe': 'none',
  'qwen-code': 'none',
  rovo: 'none'
}

describe('getTuiAgentRestSignal', () => {
  it('declares a rest signal for every launchable agent', () => {
    const derived = Object.fromEntries(
      Object.keys(TUI_AGENT_CONFIG)
        .filter(isTuiAgent)
        .map((agent) => [agent, getTuiAgentRestSignal(agent)])
    )
    expect(derived).toEqual(EXPECTED_REST_SIGNALS)
  })
})
