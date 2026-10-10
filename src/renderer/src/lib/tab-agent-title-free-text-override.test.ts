import { describe, expect, it } from 'vitest'
import { collectAgentTitleEvidence } from '../../../shared/agent-title-evidence'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'

const MENTION_ONLY_TITLE = '◑ Tab title showing Codex instead of Claude Code'
const GENUINE_CODEX_TITLE = 'Task - codex'

const BASE = { isRemote: false, hasObservedAgentSignal: true } as const

describe('title that only mentions another agent', () => {
  it('is free-text evidence yet still parses as a codex title', () => {
    expect(collectAgentTitleEvidence(MENTION_ONLY_TITLE)).toMatchObject({
      agent: null,
      reason: 'free-text-only'
    })
    expect(resolveExplicitTerminalTitleAgentType(MENTION_ONLY_TITLE)).toBe('codex')
  })

  it.each([
    ['live hook', { hookAgent: 'claude' }],
    ['foreground process', { hookAgent: null, processAgent: 'claude' }],
    ['completed hook', { hookAgent: null, focusedCompletedHookAgent: 'claude' }],
    ['launch intent', { hookAgent: null, launchAgent: 'claude' }]
  ] as const)('keeps claude from the %s', (_label, signals) => {
    expect(resolveTabAgentFromSignals({ ...BASE, title: MENTION_ONLY_TITLE, ...signals })).toBe(
      'claude'
    )
  })
})

describe('title that genuinely names another agent', () => {
  it('is anchored evidence for codex', () => {
    expect(collectAgentTitleEvidence(GENUINE_CODEX_TITLE)).toMatchObject({
      agent: 'codex',
      reason: 'anchored'
    })
  })

  it.each([
    ['completed hook', { hookAgent: null, focusedCompletedHookAgent: 'claude' }],
    ['launch intent', { hookAgent: null, launchAgent: 'claude' }]
  ] as const)('still replaces a stale %s identity', (_label, signals) => {
    expect(resolveTabAgentFromSignals({ ...BASE, title: GENUINE_CODEX_TITLE, ...signals })).toBe(
      'codex'
    )
  })
})
