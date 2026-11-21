// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { useAgentCopySettings } from './use-agent-copy-settings'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const initialState = useAppStore.getState()

function setup(agentCopies: GlobalSettings['agentCopies']) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy writes read only agentCopies and the base agent's slots.
  let settings = { agentCopies, agentCmdOverrides: { claude: 'claude-base' } } as GlobalSettings
  useAppStore.setState({ settings })
  const updateSettings = vi.fn(async (updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
    useAppStore.setState({ settings })
  })
  const { result } = renderHook(() =>
    useAgentCopySettings({ settings: useAppStore.getState().settings ?? settings, updateSettings })
  )
  const saved = () => useAppStore.getState().settings?.agentCopies ?? []
  return { result, saved }
}

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

describe('agent copy writes', () => {
  it('keeps a copy edit made under its old id while the id change was saving', async () => {
    const { result, saved } = setup([{ id: 'claude.a', name: 'A', agent: 'claude' }])
    await act(async () => {
      const moved = result.current.changeId('claude.a', 'claude.b')
      const renamed = result.current.rename('claude.a', 'Renamed')
      await Promise.all([moved, renamed])
    })
    expect(saved()).toEqual([{ id: 'claude.b', name: 'Renamed', agent: 'claude' }])
  })

  it('leaves the copy unchanged when another copy took the id first', async () => {
    const { result, saved } = setup([
      { id: 'claude.a', name: 'A', agent: 'claude' },
      { id: 'claude.b', name: 'B', agent: 'claude' }
    ])
    await act(() => result.current.changeId('claude.a', 'claude.b'))
    expect(saved().map((copy) => copy.id)).toEqual(['claude.a', 'claude.b'])
    expect(toast.error).toHaveBeenCalledWith('Another copy has this ID.')
  })

  it('saves only the field that was edited', async () => {
    const { result, saved } = setup([{ id: 'claude.a', name: 'A', agent: 'claude' }])
    await act(async () => {
      await Promise.all([
        result.current.rename('claude.a', 'New name'),
        result.current.changeId('claude.a', 'claude.new-id')
      ])
    })
    expect(saved()).toEqual([{ id: 'claude.new-id', name: 'New name', agent: 'claude' }])
  })

  it('reports an edit to a copy that is gone instead of dropping it', async () => {
    const { result } = setup([])
    await act(async () => {
      await expect(result.current.rename('claude.gone', 'X')).rejects.toThrow(
        'Unknown agent copy "claude.gone"'
      )
    })
    expect(toast.error).toHaveBeenCalled()
  })

  it('duplicates a copy from its latest saved values, after an edit still saving', async () => {
    const { result, saved } = setup([
      { id: 'claude.a', name: 'A', agent: 'claude', command: 'old' }
    ])
    await act(async () => {
      const edit = result.current.rename('claude.a', 'A2')
      result.current.duplicate({ id: 'claude', label: 'Claude' }, 'claude.a')
      await edit
      await vi.waitFor(() => expect(saved()).toHaveLength(2))
    })
    expect(saved()[1]).toMatchObject({ agent: 'claude', name: 'A2 copy', command: 'old' })
  })

  it('sends edits to a copy that took a vacated id to that copy, not to the one renamed away', async () => {
    const { result, saved } = setup([
      { id: 'claude.a', name: 'A', agent: 'claude' },
      { id: 'claude.c', name: 'C', agent: 'claude' }
    ])
    await act(() => result.current.changeId('claude.a', 'claude.b'))
    await act(() => result.current.changeId('claude.c', 'claude.a'))
    await act(() => result.current.rename('claude.a', 'New A'))
    await act(() => result.current.remove('claude.a'))
    expect(saved()).toEqual([{ id: 'claude.b', name: 'A', agent: 'claude' }])
  })

  it('duplicates nothing when the copy to duplicate was deleted first', async () => {
    const { result, saved } = setup([{ id: 'claude.a', name: 'A', agent: 'claude' }])
    await act(async () => {
      const removed = result.current.remove('claude.a')
      result.current.duplicate({ id: 'claude', label: 'Claude' }, 'claude.a')
      await removed
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalled())
    })
    expect(saved()).toEqual([])
  })
})
