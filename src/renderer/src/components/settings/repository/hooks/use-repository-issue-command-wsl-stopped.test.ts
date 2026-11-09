// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(async () => undefined)
}))
vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({
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
})
