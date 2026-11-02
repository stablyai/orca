// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidebarProjectDrop } from './useSidebarProjectDrop'

const mocks = vi.hoisted(() => {
  const settings: { activeRuntimeEnvironmentId: string | null; experimentalWslHosts?: boolean } = {
    activeRuntimeEnvironmentId: null
  }
  const runtimeEnvironments: {
    id: string
    orcadDeployment?: { kind: 'wsl'; distro: string; localPort: number; remotePort: number }
  }[] = []
  return {
    state: { settings, runtimeEnvironments, openModal: vi.fn() },
    stat: vi.fn(),
    prepare: vi.fn(),
    toastError: vi.fn(),
    droppedPath: '/Users/me/project'
  }
})
vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, warning: vi.fn() } }))

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
  mocks.state.runtimeEnvironments = []
  mocks.droppedPath = '/Users/me/project'
  mocks.stat.mockResolvedValue({ isDirectory: true })
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: () => mocks.droppedPath,
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

describe('Explorer folder drops for a WSL host (Windows)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    mocks.state.settings = { activeRuntimeEnvironmentId: null, experimentalWslHosts: true }
    mocks.state.runtimeEnvironments = [
      {
        id: 'wsl:Ubuntu',
        orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 4100, remotePort: 4200 }
      }
    ]
  })

  it('opens Add Project on the WSL host with the Linux path of a \\\\wsl.localhost drop', async () => {
    mocks.droppedPath = '\\\\wsl.localhost\\ubuntu\\home\\me\\my repo'
    const view = render(<SidebarProbe />)
    drag(view.getByTestId('worktree-card'), 'drop')
    await waitFor(() =>
      expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo', {
        droppedHostPath: { hostId: 'runtime:wsl%3AUbuntu', path: '/home/me/my repo' }
      })
    )
  })

  it('accepts the drag while the WSL host is focused, but keeps a drive folder off it', async () => {
    mocks.state.settings.activeRuntimeEnvironmentId = 'wsl:Ubuntu'
    mocks.droppedPath = 'C:\\src\\app'
    const view = render(<SidebarProbe />)
    expect(drag(view.getByTestId('worktree-card'), 'dragover').dropEffect).toBe('copy')
    drag(view.getByTestId('worktree-card'), 'drop')
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Folders on a Windows drive stay on this computer, not in Ubuntu.',
        expect.anything()
      )
    )
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.state.openModal).not.toHaveBeenCalled()
  })

  it('leaves a \\\\wsl.localhost drop local while the experiment is off', async () => {
    mocks.state.settings.experimentalWslHosts = false
    mocks.droppedPath = '\\\\wsl.localhost\\Ubuntu\\home\\me'
    const view = render(<SidebarProbe />)
    drag(view.getByTestId('worktree-card'), 'drop')
    await waitFor(() =>
      expect(mocks.state.openModal).toHaveBeenCalledWith('add-repo', {
        droppedLocalPath: '\\\\wsl.localhost\\Ubuntu\\home\\me'
      })
    )
  })
})
