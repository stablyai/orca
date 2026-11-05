// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { EMPTY_PALETTE_FILTER } from '../cmd-j/palette-filter'
import { useWorktreeJumpPaletteAgentGroups } from './use-worktree-jump-palette-agent-groups'
import { makeAgentEntry, makeManyTabState, makeRepo } from './worktree-jump-palette-test-fixtures'

const initialState = useAppStore.getInitialState()
const options = {
  visible: true,
  hasQuery: false,
  query: '',
  filter: EMPTY_PALETTE_FILTER,
  filterPredicate: null,
  defaultHostId: 'local' as const
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  useAppStore.setState(initialState, true)
})

it('counts and offers older unread results behind more than 80 newer read completions', () => {
  const now = Date.now()
  const entries = Array.from({ length: 83 }, (_, index) =>
    makeAgentEntry(`term-${index}`, 'done', now - index * 1000)
  )
  useAppStore.setState({
    ...makeManyTabState(83),
    repos: [makeRepo()],
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry])),
    acknowledgedAgentsByPaneKey: Object.fromEntries(
      entries.slice(0, 80).map((entry) => [entry.paneKey, now])
    )
  })
  const { result } = renderHook(() => useWorktreeJumpPaletteAgentGroups(options))

  expect(
    result.current.agentGroups.map((group) => ({
      key: group.key,
      total: group.total,
      panes: group.items.map((item) => item.paneKey)
    }))
  ).toEqual([
    {
      key: 'unread-results',
      total: 3,
      panes: [
        'term-80:11111111-2222-4333-8444-555555555555',
        'term-81:11111111-2222-4333-8444-555555555555'
      ]
    }
  ])
})

it('updates captured rows without admitting new members until the next open', () => {
  const now = Date.now()
  const working = makeAgentEntry('term-0', 'working', now, { prompt: 'Initial task' })
  useAppStore.setState({
    ...makeManyTabState(2),
    repos: [makeRepo()],
    agentStatusByPaneKey: { [working.paneKey]: working }
  })
  const { result, rerender } = renderHook((props) => useWorktreeJumpPaletteAgentGroups(props), {
    initialProps: options
  })

  act(() => {
    const unrelated = makeAgentEntry('term-1', 'waiting', now + 1)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [working.paneKey]: { ...working, state: 'done', prompt: 'Finished task' },
        [unrelated.paneKey]: unrelated
      }
    })
  })
  expect(result.current.agentGroups.map((group) => group.key)).toEqual(['working'])
  expect(result.current.resolveAgentRowThread(working.paneKey)).toMatchObject({
    available: true,
    thread: { paneEntry: { state: 'done', prompt: 'Finished task' }, unread: true }
  })

  act(() => {
    useAppStore.setState({ agentStatusByPaneKey: {} })
  })
  expect(result.current.resolveAgentRowThread(working.paneKey)).toMatchObject({ available: false })
  expect(result.current.agentGroups.map((group) => group.key)).toEqual(['working'])

  act(() => {
    const waiting = makeAgentEntry('term-1', 'waiting', now + 1)
    useAppStore.setState({ agentStatusByPaneKey: { [waiting.paneKey]: waiting } })
  })
  rerender({ ...options, visible: false })
  rerender(options)
  expect(result.current.agentGroups.map((group) => group.key)).toEqual(['needs-you'])
})
