/**
 * Memory-leak regression: retainedAgentsByPaneKey must stay bounded.
 *
 * `retainedAgentsByPaneKey` is a Record keyed by ephemeral paneKey
 * (`${tabId}:${leafId}`, where leafId is a fresh UUID minted per pane and never
 * reused). Every agent that finishes and then vanishes from the live map is
 * snapshotted here via `retainAgents`. Each snapshot is a full RetainedAgentEntry
 * — an AgentStatusEntry (which carries an up-to-8KB lastAssistantMessage, an
 * up-to-16KB interactivePrompt, a prompt, and up to 20 stateHistory rows) plus a
 * full TerminalTab snapshot.
 *
 * Before the fix, `retainAgents` only ever wrote entries and never capped them,
 * so the map grew monotonically with the number of distinct completed-agent
 * paneKeys observed. The only removal paths are worktree removal
 * (`pruneRetainedAgents`) and explicit user dismissal — neither of which runs
 * while a long-lived worktree stays open. Under a multi-hour multi-agent /
 * orchestration session (sub-agents complete continuously), this large-payload
 * accumulator is the dominant driver of the renderer JS-heap OOM seen in the
 * Windows crash bundles (heap climbing to the 3586 MB old-space limit).
 *
 * The fix caps it to MAX_RETAINED_AGENTS, evicting the oldest-retained keys
 * (insertion order == retention order, so the newest completions survive).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'

// MAX_RETAINED_AGENTS is module-private; mirror its value here.
const MAX_RETAINED_AGENTS = 500

// Approximate the worst-case per-entry payload the production type permits, so
// the leak's byte weight (not just entry count) is visible in the assertions.
const BIG_ASSISTANT_MESSAGE = 'a'.repeat(8 * 1024)
const BIG_INTERACTIVE_PROMPT = 'q'.repeat(16 * 1024)

function makeRetained(index: number, worktreeId = 'wt-x'): RetainedAgentEntry {
  const paneKey = `tab-${index}:leaf-${index}`
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: `prompt ${index}`,
    updatedAt: index,
    stateStartedAt: index,
    paneKey,
    stateHistory: [],
    lastAssistantMessage: BIG_ASSISTANT_MESSAGE,
    interactivePrompt: BIG_INTERACTIVE_PROMPT
  }
  return {
    entry,
    worktreeId,
    tab: { id: `tab-${index}`, title: 'claude' } as unknown as TerminalTab,
    agentType: 'claude',
    startedAt: index
  }
}

describe('retainedAgentsByPaneKey stays bounded (leak regression)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps retainedAgentsByPaneKey and keeps the most recently retained keys', () => {
    const store = createTestStore()

    // Drive the production retention path with more distinct ephemeral paneKeys
    // than the cap allows — one call per completion, as production does.
    const total = MAX_RETAINED_AGENTS + 200
    for (let i = 0; i < total; i++) {
      store.getState().retainAgents([makeRetained(i)])
    }

    const retained = store.getState().retainedAgentsByPaneKey
    // Bounded — not `total`. Without the cap this is MAX_RETAINED_AGENTS + 200.
    expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)

    // The newest completions survive; the oldest are evicted.
    expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
    expect(retained['tab-0:leaf-0']).toBeUndefined()
    // The exact eviction boundary: everything before (total - cap) is gone.
    expect(
      retained[`tab-${total - MAX_RETAINED_AGENTS - 1}:leaf-${total - MAX_RETAINED_AGENTS - 1}`]
    ).toBeUndefined()
    expect(
      retained[`tab-${total - MAX_RETAINED_AGENTS}:leaf-${total - MAX_RETAINED_AGENTS}`]
    ).toBeDefined()
  })

  it('caps even when many completions are retained in a single batch', () => {
    const store = createTestStore()
    const total = MAX_RETAINED_AGENTS + 50
    const batch = Array.from({ length: total }, (_, i) => makeRetained(i))

    store.getState().retainAgents(batch)

    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
    expect(retained[`tab-${total - 1}:leaf-${total - 1}`]).toBeDefined()
    expect(retained['tab-0:leaf-0']).toBeUndefined()
  })

  it('does not evict anything while under the cap', () => {
    const store = createTestStore()
    for (let i = 0; i < MAX_RETAINED_AGENTS; i++) {
      store.getState().retainAgents([makeRetained(i)])
    }
    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(MAX_RETAINED_AGENTS)
    expect(retained['tab-0:leaf-0']).toBeDefined()
  })

  it('re-retaining an existing paneKey overwrites in place and never grows the count', () => {
    const store = createTestStore()
    const first = makeRetained(0)
    store.getState().retainAgents([first])
    // Same paneKey, fresh snapshot (e.g. a later status update for the same pane).
    const updated = makeRetained(0)
    updated.entry.prompt = 'updated'
    store.getState().retainAgents([updated])

    const retained = store.getState().retainedAgentsByPaneKey
    expect(Object.keys(retained)).toHaveLength(1)
    expect(retained['tab-0:leaf-0'].entry.prompt).toBe('updated')
  })
})
