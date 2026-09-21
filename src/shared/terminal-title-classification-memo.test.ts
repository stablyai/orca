import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as AgentNameTokenMatchModule from './agent-name-token-match'
import { getAgentLabel } from './agent-title-identity'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { memoizeTitleClassification } from './terminal-title-classification-memo'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'

// Why a module mock: `titleHasAgentName` is the leaf regex test every title
// classifier funnels into, so counting its invocations is the direct measure of
// what one store write costs when no title has changed.
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

    // Unmemoized this is STORE_WRITES x titles x the whole regex ladder — 4,350
    // leaf matches for this fixture. Memoized, an unchanged title costs nothing.
    expect(classifierCalls).not.toHaveBeenCalled()
  })

  it('classifies a title once no matter how many readers ask', () => {
    const title = 'aider running'
    getAgentLabel(title)
    const firstReadCalls = classifierCalls.mock.calls.length
    expect(firstReadCalls).toBeGreaterThan(0)

    for (let read = 0; read < 20; read += 1) {
      getAgentLabel(title)
    }
    expect(classifierCalls.mock.calls.length).toBe(firstReadCalls)
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
    // Cap is 1024; overflow it and confirm the newest key still hits while the
    // oldest was evicted.
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
