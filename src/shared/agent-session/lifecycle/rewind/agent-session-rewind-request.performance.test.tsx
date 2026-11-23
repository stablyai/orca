// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../view/live-read/structured-agent-session-reducer'
import { noteStreamedTextRevision } from '../../view/structured-agent-session-streamed-text-rows'
import * as targets from './agent-session-rewind-targets'
import {
  createAgentSessionRewindHook,
  type AgentSessionRewindInput
} from './agent-session-rewind-request'

vi.mock('./agent-session-rewind-targets', { spy: true })

afterEach(cleanup)

const useRewind = createAgentSessionRewindHook(
  { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState },
  () => ''
)

const row = (
  sequence: number,
  role: 'user' | 'assistant',
  text: string
): AgentJournalRenderItem => ({
  itemId: `${role}-${sequence}`,
  revision: 1,
  sequence,
  observedAt: 1,
  body: { kind: 'message', role, blocks: [{ type: 'text', text }] }
})

/** Target and floor derivations over a stream of 20 text-only windows into the last reply. */
function derivationsStreaming(turns: number): { targetScans: number; floorScans: number } {
  const derive = vi.mocked(targets.agentSessionRewindTargetIds)
  const floor = vi.mocked(targets.agentSessionRewindContextFloor)
  derive.mockClear()
  floor.mockClear()
  const saved = Array.from({ length: turns * 2 }, (_, index) =>
    row(index + 1, index % 2 === 0 ? 'user' : 'assistant', `Row ${index}`)
  )
  const input = (items: readonly AgentJournalRenderItem[]): AgentSessionRewindInput => ({
    sessionId: 'session',
    capturePresentation: () => () => true,
    state: { ...EMPTY_STRUCTURED_AGENT_SESSION, items: [...items], epoch: 'epoch' },
    support: undefined,
    blocked: false,
    send: () => new Promise(() => {}),
    notify: { error: () => {}, message: () => {} }
  })
  let items = saved
  // The state's items are a fresh array each window, revised only in the reply's text.
  const linked = (next: AgentJournalRenderItem[], from: readonly AgentJournalRenderItem[]) => {
    noteStreamedTextRevision(next, from)
    return next
  }
  const first = input(items)
  noteStreamedTextRevision(first.state.items, saved)
  const { rerender } = renderHook(({ value }) => useRewind(value), {
    initialProps: { value: first }
  })
  let text = `Row ${turns * 2 - 1}`
  for (let window = 0; window < 20; window++) {
    text += ' more'
    items = linked([...items.slice(0, -1), row(turns * 2, 'assistant', text)], items)
    const value = input(items)
    noteStreamedTextRevision(value.state.items, items)
    rerender({ value })
  }
  const scans = { targetScans: derive.mock.calls.length, floorScans: floor.mock.calls.length }
  // A new row is structure: the targets are found again.
  const grown = [...items, row(turns * 2 + 1, 'user', 'Next')]
  rerender({ value: input(grown) })
  expect(derive.mock.calls.length).toBe(scans.targetScans + 1)
  return scans
}

// Perf contract: rewind targets and the context floor read no reply text, so a streaming reply
// derives them once, at any history length.
it('derives rewind targets once while a reply streams', () => {
  expect(derivationsStreaming(200)).toEqual({ targetScans: 1, floorScans: 1 })
  expect(derivationsStreaming(2000)).toEqual({ targetScans: 1, floorScans: 1 })
})
