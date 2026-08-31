import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS,
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} from './sync-runtime-graph'

// Reference: the pre-change whole-array serialization, kept verbatim. The bucket
// width is read from the module under test so a drifted constant cannot make this
// reference silently disagree for a reason unrelated to the change.
const BUCKET_MS = AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS
function referenceProjection(map: AppState['agentStatusByPaneKey']): string {
  return JSON.stringify(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([paneKey, entry]) => ({
        paneKey,
        entryPaneKey: entry.paneKey,
        state: entry.state,
        workingMode: entry.workingMode ?? null,
        prompt: entry.prompt,
        updatedAtBucket: Math.floor(entry.updatedAt / BUCKET_MS),
        stateStartedAt: entry.stateStartedAt,
        agentType: entry.agentType ?? null,
        terminalTitle: entry.terminalTitle ?? null,
        stateHistory: entry.stateHistory.map((history) => ({
          state: history.state,
          prompt: history.prompt,
          startedAt: history.startedAt,
          interrupted: history.interrupted ?? null
        })),
        toolName: entry.toolName ?? null,
        toolInput: entry.toolInput ?? null,
        interactivePrompt: entry.interactivePrompt ?? null,
        lastAssistantMessage: entry.lastAssistantMessage ?? null,
        interrupted: entry.interrupted ?? null
      }))
  )
}

function makeEntry(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    paneKey: `tab-${index}:leaf-0`,
    state: 'working',
    prompt: `prompt ${index} with "quotes" and \\ backslash`,
    updatedAt: 1740000000000 + index * 17,
    stateStartedAt: 1740000000000,
    agentType: 'claude',
    terminalTitle: `agent ${index} 日本 \u{1f389}`,
    stateHistory: Array.from({ length: 3 }, (_value, h) => ({
      state: 'working',
      prompt: `step ${h}`,
      startedAt: 1740000000000 + h
    })),
    toolName: 'shell_command',
    toolInput: 'ls -la',
    lastAssistantMessage: 'answer',
    ...overrides
  } as never
}

describe('mobile agent-status projection equivalence', () => {
  it('matches the whole-array serialization across shapes and cache reuse', () => {
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const shapes: AppState['agentStatusByPaneKey'][] = []
    shapes.push({})
    shapes.push({ 'tab-0:leaf-0': makeEntry(0) })
    shapes.push({ 'tab-0:leaf-0': makeEntry(0, { workingMode: 'monitoring' }) })
    const many: AppState['agentStatusByPaneKey'] = {}
    for (let index = 0; index < 12; index += 1) {
      many[`tab-${index}:leaf-0`] = makeEntry(index)
    }
    shapes.push(many)
    // Optional fields absent entirely, which the ?? null fallbacks must cover.
    shapes.push({
      'tab-9:leaf-1': makeEntry(9, {
        agentType: undefined,
        terminalTitle: undefined,
        toolName: undefined,
        toolInput: undefined,
        interactivePrompt: undefined,
        lastAssistantMessage: undefined,
        interrupted: undefined
      })
    })
    // Keys deliberately out of insertion order to pin the sort.
    shapes.push({
      'tab-z:leaf-0': makeEntry(2),
      'tab-a:leaf-0': makeEntry(1),
      'tab-m:leaf-0': makeEntry(3)
    })

    for (const [index, shape] of shapes.entries()) {
      expect({
        index,
        projection: buildRuntimeMobileAgentStatusProjectionForTests(shape)
      }).toEqual({ index, projection: referenceProjection(shape) })
    }

    // Now exercise the cache: replace one entry the way setAgentStatus does and
    // confirm the reused rows still produce the reference output. The changes must
    // be observable in the projection — a sub-bucket updatedAt nudge is not, so a
    // stale-entry reuse bug would slip through.
    let current = many
    for (let round = 0; round < 4; round += 1) {
      current = {
        ...current,
        'tab-0:leaf-0': makeEntry(0, {
          updatedAt: 1740000000000 + BUCKET_MS * 3 * (round + 1),
          state: round % 2 === 0 ? 'done' : 'working',
          prompt: `changed prompt round ${round}`,
          lastAssistantMessage: `answer round ${round}`
        })
      }
      expect({
        round,
        projection: buildRuntimeMobileAgentStatusProjectionForTests(current)
      }).toEqual({ round, projection: referenceProjection(current) })
    }
  })
})
