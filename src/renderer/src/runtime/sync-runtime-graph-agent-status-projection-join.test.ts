import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} from './sync-runtime-graph/agent-status-projection'

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

/** A collection refresh can replace its container while preserving the rows. */
function respread(map: AppState['agentStatusByPaneKey']): AppState['agentStatusByPaneKey'] {
  return { ...map }
}

function countJoins(run: () => string): {
  result: string
  joins: number
  sorts: number
} {
  const originalJoin = Array.prototype.join
  const originalSort = Array.prototype.sort
  let joins = 0
  let sorts = 0
  const joinSpy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
    this: unknown[],
    separator?: string
  ) {
    joins += 1
    return originalJoin.call(this, separator)
  })
  const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
    this: unknown[],
    compare?: (a: unknown, b: unknown) => number
  ) {
    sorts += 1
    return originalSort.call(this, compare)
  })
  try {
    return { result: run(), joins, sorts }
  } finally {
    joinSpy.mockRestore()
    sortSpy.mockRestore()
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

    // A new map identity with identical entry references.
    const { result, joins, sorts } = countJoins(() =>
      buildRuntimeMobileAgentStatusProjectionForTests(respread(map))
    )

    expect(result).toBe(first)
    expect(joins).toBe(0)
    expect(sorts).toBe(0)
  })

  it('does not rejoin accumulated previews for timestamp-only heartbeats', () => {
    let map = mapOf(Array.from({ length: 500 }, (_, index) => index))
    for (const paneKey of Object.keys(map)) {
      map[paneKey] = {
        ...map[paneKey],
        updatedAt: 30_000_000,
        lastAssistantMessage: 'answer '.repeat(1_000)
      }
    }
    const first = buildRuntimeMobileAgentStatusProjectionForTests(map)

    const { result, joins } = countJoins(() => {
      let projection = first
      for (let index = 0; index < 50; index++) {
        const paneKey = `tab-${index}:leaf-0`
        map = { ...map, [paneKey]: { ...map[paneKey], updatedAt: 30_000_001 + index } }
        projection = buildRuntimeMobileAgentStatusProjectionForTests(map)
      }
      return projection
    })

    expect(result).toBe(first)
    expect(joins).toBe(0)

    const paneKey = 'tab-0:leaf-0'
    const nextBucket = { ...map, [paneKey]: { ...map[paneKey], updatedAt: 30_030_000 } }
    expect(buildRuntimeMobileAgentStatusProjectionForTests(nextBucket)).not.toBe(first)
    expect(
      buildRuntimeMobileAgentStatusProjectionForTests({
        ...map,
        [paneKey]: { ...map[paneKey], lastAssistantMessage: 'A new answer' }
      })
    ).not.toBe(first)
  })
})
