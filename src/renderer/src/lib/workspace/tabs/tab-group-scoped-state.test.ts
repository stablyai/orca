import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { createTabGroupScopedState } from './tab-group-scoped-state'

const group = (id: string) => ({ id, worktreeId: 'wt-1', activeTabId: null, tabOrder: [] })

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('tab-group scoped state', () => {
  it('is disposed when its group closes and when its workspace is removed, keeping other groups', () => {
    const disposed: string[] = []
    const state = createTabGroupScopedState<string>((value) => disposed.push(value))
    useAppStore.setState({ groupsByWorktree: { 'wt-1': [group('a'), group('b')] } })
    state.set('wt-1', 'a', 'kept-a')
    state.set('wt-1', 'b', 'kept-b')
    state.set('wt-1', 'gone', 'never-stored')

    useAppStore.setState({ groupsByWorktree: { 'wt-1': [group('a')] } })
    expect(state.get('wt-1', 'b')).toBeUndefined()
    expect(state.get('wt-1', 'a')).toBe('kept-a')

    useAppStore.setState({ groupsByWorktree: {} })
    expect(state.get('wt-1', 'a')).toBeUndefined()
    expect(state.get('wt-1', 'gone')).toBeUndefined()
    expect(disposed).toEqual(['kept-b', 'kept-a'])
  })
})
