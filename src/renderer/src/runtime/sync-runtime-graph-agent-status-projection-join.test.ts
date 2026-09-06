import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} from './sync-runtime-graph'

function makeEntry(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    paneKey: `tab-${index}:leaf-0`,
    state: 'working',
    prompt: `prompt ${index}`,
    updatedAt: 1740000000000 + index * 17,
    stateStartedAt: 1740000000000,
    agentType: 'claude',
    terminalTitle: `agent ${index}`,
    stateHistory: [{ state: 'working', prompt: 'step', startedAt: 1740000000000 }],
    toolName: 'shell_command',
    toolInput: 'ls -la',
    lastAssistantMessage: 'answer',
    ...overrides
  } as never
}

function mapOf(indices: readonly number[]): AppState['agentStatusByPaneKey'] {
  const map: AppState['agentStatusByPaneKey'] = {}
  for (const index of indices) {
    map[`tab-${index}:leaf-0`] = makeEntry(index)
  }
  return map
}

/** Re-spread with the same entry objects, as a status ping does. */
function respread(map: AppState['agentStatusByPaneKey']): AppState['agentStatusByPaneKey'] {
  return { ...map }
}

function countJoins(run: () => string): { result: string; joins: number } {
  const original = Array.prototype.join
  let joins = 0
  const spy = vi
    .spyOn(Array.prototype, 'join')
    .mockImplementation(function (this: unknown[], separator?: string) {
      joins += 1
      return original.call(this, separator)
    })
  try {
    return { result: run(), joins }
  } finally {
    spy.mockRestore()
  }
}

describe('agent-status projection join short circuit', () => {
  afterEach(() => {
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
  })

  it('skips the join when a re-spread reuses every entry', () => {
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const map = mapOf([0, 1, 2])
    const first = buildRuntimeMobileAgentStatusProjectionForTests(map)

    // A new map identity with identical entry references — the common ping shape.
    const { result, joins } = countJoins(() =>
      buildRuntimeMobileAgentStatusProjectionForTests(respread(map))
    )

    expect(result).toBe(first)
    expect(joins).toBe(0)
  })

  it('still rebuilds when an entry changes', () => {
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const map = mapOf([0, 1])
    const first = buildRuntimeMobileAgentStatusProjectionForTests(map)

    const changed = { ...map, 'tab-1:leaf-0': makeEntry(1, { state: 'idle' }) }
    const { result, joins } = countJoins(() =>
      buildRuntimeMobileAgentStatusProjectionForTests(changed)
    )

    expect(result).not.toBe(first)
    expect(joins).toBeGreaterThan(0)
  })

  it('still rebuilds when a pane is removed, even though every survivor is reused', () => {
    // The reuse check alone cannot see a removal; only the entry-count check does.
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const map = mapOf([0, 1])
    const first = buildRuntimeMobileAgentStatusProjectionForTests(map)

    const removed = { 'tab-0:leaf-0': map['tab-0:leaf-0'] }
    const result = buildRuntimeMobileAgentStatusProjectionForTests(removed)

    expect(result).not.toBe(first)
    expect(result).toBe(
      buildRuntimeMobileAgentStatusProjectionForTests({ 'tab-0:leaf-0': map['tab-0:leaf-0'] })
    )
  })

  it('still rebuilds when a pane is added', () => {
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const map = mapOf([0])
    const first = buildRuntimeMobileAgentStatusProjectionForTests(map)

    const added = { ...map, 'tab-9:leaf-0': makeEntry(9) }
    const result = buildRuntimeMobileAgentStatusProjectionForTests(added)

    expect(result).not.toBe(first)
    expect(result).toContain('tab-9:leaf-0')
  })
})
