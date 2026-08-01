/**
 * Pins the side-effect imports in store/index.ts that make every census register on
 * store load. Without them a census registers only when its owning subsystem happens
 * to load, and a missing key in an OOM report stops meaning "the instrument never
 * ran" — the contract the whole profile is read against. Deleting any of those
 * imports is otherwise green.
 */
import { describe, expect, it } from 'vitest'
import './index'
import { collectRendererMemoryProfileCounts } from '../lib/renderer-memory-profile'

describe('renderer memory profile registration', () => {
  it('registers every census on store load, zeroed rather than absent', () => {
    const counts = collectRendererMemoryProfileCounts()

    expect(counts).toMatchObject({
      'editorContent.panels': 0,
      'editorContent.files': 0,
      'editorContent.chars': 0,
      'editorContent.diffTabs': 0,
      'editorContent.diffChars': 0,
      'editorContent.droppedPanels': 0,
      'editorContent.readErrors': 0,
      'terminalOutputBacklog.terminals': 0,
      'terminalOutputBacklog.chars': 0,
      'terminalOutputBacklog.maxTerminalChars': 0,
      'monacoModels.models': 0,
      'monacoModels.chars': 0,
      'monacoModels.lines': 0,
      'liveTerminalBuffers.panes': 0,
      'liveTerminalBuffers.lines': 0,
      'liveTerminalBuffers.cells': 0,
      'liveTerminalBuffers.altScreenPanes': 0,
      'liveTerminalBuffers.droppedPanes': 0,
      'terminalScrollback.layouts': 0,
      'terminalScrollback.buffers': 0,
      'terminalScrollback.chars': 0,
      'terminalScrollback.coldRestores': 0,
      'terminalScrollback.coldRestoreChars': 0
    })
    expect(counts).not.toHaveProperty('profile.truncated')
  })

  it('leaves room in the 64-count budget for the store walk', () => {
    expect(Object.keys(collectRendererMemoryProfileCounts()).length).toBeLessThan(64)
  })

  it("walks every fixed census before 'store', so a budget overrun drops slice sizes", () => {
    // Why order is the contract: contributors are walked in registration order and the
    // profile stops at 64 counts, so whatever registers last is what an overrun omits.
    // 'store' is the only contributor whose key count grows with session state, and its
    // own `unreportedCollections` already says when it was cut short — a fixed census
    // dropped instead reads as "measured, nothing held".
    const keys = Object.keys(collectRendererMemoryProfileCounts())
    const firstStoreKey = keys.findIndex((key) => key.startsWith('store.'))
    const lastFixedCensusKey = keys.findLastIndex(
      (key) => !key.startsWith('store.') && !key.startsWith('profile.')
    )

    expect(firstStoreKey).toBeGreaterThan(-1)
    expect(lastFixedCensusKey).toBeLessThan(firstStoreKey)
  })
})
