import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as AgentNameTokenMatchModule from './agent-name-token-match'
import { getAgentLabel } from './agent-title-identity'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { memoizeTitleClassification } from './terminal-title-classification-memo'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
// Count the leaf titleHasAgentName regex to measure unchanged-title work across store writes.
vi.mock('./agent-name-token-match', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentNameTokenMatchModule>()
  return { ...actual, titleHasAgentName: vi.fn(actual.titleHasAgentName) }
})

const classifierCalls = vi.mocked(AgentNameTokenMatchModule.titleHasAgentName)

// Titles a real sidebar holds steady while unrelated agent-status writes churn.
const UNCHANGED_TITLES = [
  'codex working',
  'opencode-blinker',
  'zsh',
  '✳ Claude Code',
  'copilot.exe - action required',
  'gemini',
  'cursor agent'
]
const STORE_WRITES = 50

function classifyEveryTitle(): void {
  for (const title of UNCHANGED_TITLES) {
    getAgentLabel(title)
    detectAgentStatusFromTitle(title)
    resolveExplicitTerminalTitleAgentType(title)
  }
}

describe('terminal title classification memo', () => {
  beforeEach(() => {
    classifierCalls.mockClear()
  })

  it('classifies each distinct title once across repeated store writes', () => {
    // Warm the caches the way the first render would, then measure steady state.
    classifyEveryTitle()
    classifierCalls.mockClear()

    for (let write = 0; write < STORE_WRITES; write += 1) {
      classifyEveryTitle()
    }

    // Without memoization this fixture makes 4350 leaf matches; steady-state unchanged titles should make none.
    expect(classifierCalls).not.toHaveBeenCalled()
  })

  it('reclassifies as soon as the title changes', () => {
    expect(getAgentLabel('codex ready')).toBe('Codex')
    expect(getAgentLabel('grok ready')).toBe('Grok')
    expect(detectAgentStatusFromTitle('codex ready')).toBe('idle')
    expect(detectAgentStatusFromTitle('codex working')).toBe('working')
  })

  it('caches null and false verdicts, not just truthy ones', () => {
    const classify = vi.fn((): string | null => null)
    const memoized = memoizeTitleClassification(classify)
    expect(memoized('zsh')).toBeNull()
    expect(memoized('zsh')).toBeNull()
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('evicts oldest entries instead of growing without bound', () => {
    const classify = vi.fn((title: string) => title.length)
    const memoized = memoizeTitleClassification(classify)
    for (let index = 0; index < 1030; index += 1) {
      memoized(`title-${index}`)
    }
    const afterFill = classify.mock.calls.length
    memoized('title-1029')
    expect(classify.mock.calls.length).toBe(afterFill)
    memoized('title-0')
    expect(classify.mock.calls.length).toBe(afterFill + 1)
  })
})
