// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { useNativeChatReaderOpens } from './use-native-chat-reader-opens'

function harness() {
  const spies = {
    readerOpened: vi.fn(),
    readerClosed: vi.fn(),
    abortNavigation: vi.fn(),
    setSectionOpen: vi.fn(),
    setRosterOpen: vi.fn()
  }
  const { result } = renderHook(() => {
    const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set())
    return useNativeChatReaderOpens({
      subagentDisclosure: {
        setSectionOpen: spies.setSectionOpen,
        setRosterOpen: spies.setRosterOpen
      },
      expandedTurnIds,
      setExpandedTurnIds,
      follow: { readerOpened: spies.readerOpened, readerClosed: spies.readerClosed },
      abortNavigation: spies.abortNavigation
    })
  })
  const reacted = (): number => spies.readerOpened.mock.calls.length
  return { result, spies, reacted }
}

// Each way a reader opens a row reports it under its own identity and abandons a history jump still paging.
it.each([
  [
    'a disclosure',
    'run:1',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) =>
      opens.disclosures.onToggle?.('run:1', true)
  ],
  [
    'a folded turn',
    'turn:turn-1',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) => opens.toggleExpandedTurn('turn-1')
  ],
  [
    'a subagent section',
    'section:a',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) =>
      opens.subagentDisclosure.setSectionOpen('a', true)
  ],
  [
    'a subagent roster',
    'roster:r',
    (opens: ReturnType<typeof useNativeChatReaderOpens>) =>
      opens.subagentDisclosure.setRosterOpen('r', true)
  ]
])('reacts to the reader opening %s', (_kind, row, open) => {
  const { result, spies } = harness()
  act(() => open(result.current))
  expect(spies.readerOpened).toHaveBeenCalledExactlyOnceWith(row)
  expect(spies.abortNavigation).toHaveBeenCalledOnce()
})

it('reports each close under the identity its open used, without stopping following again', () => {
  const { result, spies, reacted } = harness()
  act(() => result.current.toggleExpandedTurn('turn-1'))
  expect(reacted()).toBe(1)

  act(() => result.current.toggleExpandedTurn('turn-1'))
  act(() => result.current.subagentDisclosure.setSectionOpen('a', false))
  act(() => result.current.subagentDisclosure.setRosterOpen('r', false))

  act(() => result.current.disclosures.onToggle?.('run:1', false))

  expect(reacted()).toBe(1)
  expect(spies.readerClosed.mock.calls).toEqual([
    ['turn:turn-1'],
    ['section:a'],
    ['roster:r'],
    ['run:1']
  ])
  expect(spies.setSectionOpen).toHaveBeenCalledWith('a', false)
  expect(spies.setRosterOpen).toHaveBeenCalledWith('r', false)
})
