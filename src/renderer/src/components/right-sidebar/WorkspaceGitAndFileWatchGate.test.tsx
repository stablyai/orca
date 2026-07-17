// @vitest-environment happy-dom

import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { WorkspaceGitAndFileWatchGate } from './WorkspaceGitAndFileWatchGate'

const hookCalls = vi.hoisted(() => ({ git: vi.fn(), fileWatch: vi.fn() }))

vi.mock('./useGitStatusPolling', async () => {
  const { useAppStore: useStore } = await import('@/store')
  return {
    useGitStatusPolling(options: { enabled?: boolean }): void {
      useStore((state) => state.rightSidebarPeek)
      hookCalls.git(options)
    }
  }
})

vi.mock('@/hooks/useEditorExternalWatch', async () => {
  const { useAppStore: useStore } = await import('@/store')
  return {
    useEditorExternalWatch(): void {
      useStore((state) => state.rightSidebarPeek)
      hookCalls.fileWatch()
    }
  }
})

const initialAppState = useAppStore.getInitialState()

afterEach(() => {
  useAppStore.setState(initialAppState, true)
  vi.clearAllMocks()
})

describe('WorkspaceGitAndFileWatchGate', () => {
  it('contains sidebar-driven hook renders without re-rendering its parent', () => {
    let parentRenderCount = 0
    function Parent(): React.JSX.Element {
      parentRenderCount += 1
      return <WorkspaceGitAndFileWatchGate enabled />
    }

    render(<Parent />)
    expect(parentRenderCount).toBe(1)
    expect(hookCalls.git).toHaveBeenCalledTimes(1)
    expect(hookCalls.fileWatch).toHaveBeenCalledTimes(1)

    act(() => useAppStore.setState({ rightSidebarPeek: true }))

    expect(hookCalls.git).toHaveBeenCalledTimes(2)
    expect(hookCalls.fileWatch).toHaveBeenCalledTimes(2)
    expect(parentRenderCount).toBe(1)
  })
})
