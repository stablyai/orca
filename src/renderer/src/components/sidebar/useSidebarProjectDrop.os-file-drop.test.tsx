// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidebarProjectDrop } from './useSidebarProjectDrop'

const mocks = vi.hoisted(() => {
  const settings: { activeRuntimeEnvironmentId: string | null } = {
    activeRuntimeEnvironmentId: null
  }
  return { state: { settings, openModal: vi.fn() }, stat: vi.fn(), prepare: vi.fn() }
})
vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

function SidebarProbe(): React.JSX.Element {
  const { dropOwnerRef, dropHandlers } = useSidebarProjectDrop()
  return (
    <div ref={dropOwnerRef} data-testid="sidebar" {...dropHandlers}>
      <div data-testid="worktree-card" />
    </div>
  )
}

function drag(
  target: Element,
  type: 'dragover' | 'drop'
): { dropEffect: string; defaultPrevented: boolean } {
  const transfer = { types: ['Files'], files: [new File([''], 'project')], dropEffect: 'move' }
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return { dropEffect: transfer.dropEffect, defaultPrevented: event.defaultPrevented }
}

beforeEach(() => {
  mocks.state.settings = { activeRuntimeEnvironmentId: null }
  mocks.stat.mockResolvedValue({ isDirectory: true })
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: () => '/Users/me/project',
      prepareDroppedPaths: mocks.prepare,
      stat: mocks.stat
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('project sidebar OS folder drops', () => {
  it('offers to add a dropped folder as a project', async () => {
    const view = render(<SidebarProbe />)
    expect(drag(view.getByTestId('worktree-card'), 'dragover').dropEffect).toBe('copy')
    drag(view.getByTestId('worktree-card'), 'drop')
    await waitFor(() =>
      expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo', {
        droppedLocalPath: '/Users/me/project'
      })
    )
    expect(mocks.prepare).toHaveBeenCalledWith({
      paths: ['/Users/me/project'],
      consumer: 'main-reader'
    })
  })

  it('refuses the drop while a remote runtime is active', () => {
    mocks.state.settings = { activeRuntimeEnvironmentId: 'env-1' }
    const legacyRoute = vi.fn()
    window.addEventListener('drop', legacyRoute)
    const view = render(<SidebarProbe />)
    expect(drag(view.getByTestId('worktree-card'), 'dragover').dropEffect).toBe('none')
    // The sidebar claims the refused drop, so no window-level route can act on it.
    expect(drag(view.getByTestId('worktree-card'), 'drop').defaultPrevented).toBe(true)
    window.removeEventListener('drop', legacyRoute)
    expect(legacyRoute).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.state.openModal).not.toHaveBeenCalled()
  })
})
