// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useComposerState } from './useComposerState'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const ui = {
    onFileDrop: vi.fn<Window['api']['ui']['onFileDrop']>()
  } satisfies Pick<Window['api']['ui'], 'onFileDrop'>
  const preflight = {
    detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
  } satisfies Pick<Window['api']['preflight'], 'detectAgents'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { preflight, ui }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerState integrated lifecycle', () => {
  it('composes two live composers and exposes the parent-worktree control state', () => {
    useAppStore.setState({
      repos: [],
      projects: [],
      projectGroups: [],
      projectHostSetups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {}
    })
    const unsubscribes: ReturnType<typeof vi.fn>[] = []
    vi.spyOn(window.api.ui, 'onFileDrop').mockImplementation(() => {
      const unsubscribe = vi.fn()
      unsubscribes.push(unsubscribe)
      return unsubscribe
    })

    const first = renderHook(() =>
      useComposerState({ initialName: 'first', persistDraft: false, createGateMode: 'quick' })
    )
    const second = renderHook(() =>
      useComposerState({ initialName: 'second', persistDraft: false, createGateMode: 'quick' })
    )

    expect(first.result.current.cardProps.name).toBe('first')
    expect(second.result.current.cardProps.name).toBe('second')
    expect(first.result.current.cardProps.parentWorktreeId).toBeNull()
    expect(first.result.current.cardProps.onParentWorktreeIdChange).toBeTypeOf('function')
    act(() => first.result.current.cardProps.onParentWorktreeIdChange('repo-1::/parent'))
    expect(first.result.current.cardProps.parentWorktreeId).toBe('repo-1::/parent')
    expect(window.api.ui.onFileDrop).toHaveBeenCalledTimes(2)

    second.unmount()
    first.unmount()
    expect(unsubscribes).toHaveLength(2)
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1)
  })
})
