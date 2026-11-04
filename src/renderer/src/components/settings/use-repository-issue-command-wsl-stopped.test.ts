// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(async () => undefined)
}))
vi.mock('@/runtime/runtime-hooks-client', () => ({
  readRuntimeIssueCommand: client.read,
  writeRuntimeIssueCommand: client.write
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { useRepositoryIssueCommand } from './use-repository-issue-command'

const distroRunningListeners = new Set<(distro: string) => void>()
const REFUSED = {
  status: 'error' as const,
  localContent: null,
  sharedContent: null,
  effectiveContent: null,
  localFilePath: '\\\\wsl.localhost\\Ubuntu\\repo\\.orca\\issue-command',
  source: 'none' as const,
  refusedWslDistro: 'Ubuntu'
}
const READ = {
  localContent: 'my private command',
  sharedContent: null,
  effectiveContent: 'my private command',
  localFilePath: '\\\\wsl.localhost\\Ubuntu\\repo\\.orca\\issue-command',
  source: 'local' as const
}

function emitDistroRunning(distro: string): void {
  for (const listener of distroRunningListeners) {
    listener(distro)
  }
}

function render(selectedHostId: 'local' | 'runtime:env-1' = 'local') {
  return renderHook(() =>
    useRepositoryIssueCommand({ repoId: 'repo-1', repoHostIdentity: 'local', selectedHostId })
  )
}

beforeEach(() => {
  client.read.mockReset()
  client.write.mockClear()
  distroRunningListeners.clear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      preflight: {
        onWslDistroRunning: (listener: (distro: string) => void) => {
          distroRunningListeners.add(listener)
          return () => distroRunningListeners.delete(listener)
        }
      }
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('issue command editor while its WSL distro is stopped (E9)', () => {
  it('stays read-only and never saves over the unread command', async () => {
    client.read.mockResolvedValue(REFUSED)
    const hook = render()
    await vi.waitFor(() => expect(hook.result.current.issueCommandStoppedDistro).toBe('Ubuntu'))
    expect(hook.result.current.issueCommandReadOnly).toBe(true)

    act(() => hook.result.current.setIssueCommandDraft('typed anyway'))
    await act(async () => hook.result.current.commitIssueCommand())
    hook.unmount()

    expect(client.write).not.toHaveBeenCalled()
  })

  it('reads the real command once the distro runs, then saves edits as a user act', async () => {
    client.read.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(READ)
    const hook = render()
    await vi.waitFor(() => expect(hook.result.current.issueCommandStoppedDistro).toBe('Ubuntu'))

    act(() => emitDistroRunning('ubuntu'))

    await vi.waitFor(() => expect(hook.result.current.issueCommandDraft).toBe('my private command'))
    expect(hook.result.current.issueCommandReadOnly).toBe(false)
    expect(hook.result.current.issueCommandStoppedDistro).toBeNull()
    expect(client.read).toHaveBeenCalledTimes(2)

    act(() => hook.result.current.setIssueCommandDraft('edited'))
    await act(async () => hook.result.current.commitIssueCommand())
    expect(client.write).toHaveBeenCalledWith('local', 'repo-1', 'edited', { wakeWslDistro: true })
  })

  it('re-reads when the distro started while the refused read was still in flight', async () => {
    let answer: (value: typeof REFUSED) => void = () => {}
    client.read
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValueOnce(READ)
    const hook = render()

    act(() => emitDistroRunning('Ubuntu'))
    await act(async () => answer(REFUSED))

    await vi.waitFor(() => expect(hook.result.current.issueCommandDraft).toBe('my private command'))
    expect(client.read).toHaveBeenCalledTimes(2)
  })

  it('ignores other distros', async () => {
    client.read.mockResolvedValue(REFUSED)
    const hook = render()
    await vi.waitFor(() => expect(hook.result.current.issueCommandStoppedDistro).toBe('Ubuntu'))

    act(() => emitDistroRunning('Debian'))

    expect(client.read).toHaveBeenCalledTimes(1)
  })

  it('stops waiting for the distro when the editor unmounts', async () => {
    client.read.mockResolvedValue(REFUSED)
    const hook = render()
    await vi.waitFor(() => expect(distroRunningListeners.size).toBe(1))

    hook.unmount()

    expect(distroRunningListeners.size).toBe(0)
    expect(client.read).toHaveBeenCalledTimes(1)
  })

  it('a blur with no edit saves nothing, so it never starts the distro', async () => {
    client.read.mockResolvedValue(READ)
    const hook = render()
    await vi.waitFor(() => expect(hook.result.current.issueCommandDraft).toBe('my private command'))

    await act(async () => hook.result.current.commitIssueCommand())

    expect(client.write).not.toHaveBeenCalled()
  })

  it("re-asks a paired host on window focus, since its running signal can't reach us", async () => {
    client.read.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(READ)
    const hook = render('runtime:env-1')
    await vi.waitFor(() => expect(hook.result.current.issueCommandStoppedDistro).toBe('Ubuntu'))
    expect(distroRunningListeners.size).toBe(0)

    act(() => window.dispatchEvent(new Event('focus')))

    await vi.waitFor(() => expect(hook.result.current.issueCommandDraft).toBe('my private command'))
    expect(hook.result.current.issueCommandReadOnly).toBe(false)
  })
})
