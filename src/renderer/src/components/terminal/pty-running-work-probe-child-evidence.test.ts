// hasChildProcesses=false can mean missing host evidence, especially legacy Windows relays; it must not alone prove idle.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { probePtyRunningWork } from './pty-running-work-probe'

describe('probePtyRunningWork child-process evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the host to pay for a scan, because these probes back destructive decisions', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'cmd.exe',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })

    await probePtyRunningWork(['pty-a'], { timeoutMs: 1000 })

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledWith('pty-a', {
      scanChildProcesses: true
    })
  })

  it('reports a host that could not observe the pane as unverifiable, not exited', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'cmd.exe',
      hasChildProcesses: false,
      childProcessEvidence: 'unverifiable'
    })

    const [probe] = await probePtyRunningWork(['pty-a'], { timeoutMs: 1000 })

    expect(probe).toMatchObject({
      verdict: 'unverifiable',
      reason: 'host_child_processes_unobserved',
      timedOut: false
    })
  })

  it('reports an observed-empty pane as exited', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'cmd.exe',
      hasChildProcesses: false,
      childProcessEvidence: 'no-children'
    })

    const [probe] = await probePtyRunningWork(['pty-a'], { timeoutMs: 1000 })

    expect(probe?.verdict).toBe('exited')
  })

  it('reports an observed child as live', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'PING.EXE',
      hasChildProcesses: true,
      childProcessEvidence: 'children'
    })

    const [probe] = await probePtyRunningWork(['pty-a'], { timeoutMs: 1000 })

    expect(probe?.verdict).toBe('live')
  })

  it('keeps the boolean meaning for a host that never published the verdict', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValueOnce({
      foregroundProcess: 'node',
      hasChildProcesses: true
    })
    inspectRuntimeTerminalProcessMock.mockResolvedValueOnce({
      foregroundProcess: 'bash',
      hasChildProcesses: false
    })

    const [live] = await probePtyRunningWork(['pty-a'], { timeoutMs: 1000 })
    const [idle] = await probePtyRunningWork(['pty-b'], { timeoutMs: 1000 })

    expect(live?.verdict).toBe('live')
    expect(idle?.verdict).toBe('exited')
  })
})
