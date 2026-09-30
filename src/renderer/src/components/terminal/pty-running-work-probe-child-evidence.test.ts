// The probe is the one place an inspection becomes a verdict, so it is the one place that has to
// know `hasChildProcesses` cannot hold the third answer. A host that could not read its own process
// table spells that the same way as one that read it and found nothing; Windows relays spelled it
// `false` unconditionally, which read here as `exited` -- an idle verdict for a pane nobody looked at.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { probePtyRunningWork } from './pty-running-work-probe'

const SETTINGS = { activeRuntimeEnvironmentId: null }

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

    await probePtyRunningWork(SETTINGS, ['pty-a'], { timeoutMs: 1000 })

    expect(inspectRuntimeTerminalProcessMock).toHaveBeenCalledWith(SETTINGS, 'pty-a', {
      scanChildProcesses: true
    })
  })

  it('reports a host that could not observe the pane as unverifiable, not exited', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'cmd.exe',
      hasChildProcesses: false,
      childProcessEvidence: 'unverifiable'
    })

    const [probe] = await probePtyRunningWork(SETTINGS, ['pty-a'], { timeoutMs: 1000 })

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

    const [probe] = await probePtyRunningWork(SETTINGS, ['pty-a'], { timeoutMs: 1000 })

    expect(probe?.verdict).toBe('exited')
  })

  it('reports an observed child as live', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'PING.EXE',
      hasChildProcesses: true,
      childProcessEvidence: 'children'
    })

    const [probe] = await probePtyRunningWork(SETTINGS, ['pty-a'], { timeoutMs: 1000 })

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

    const [live] = await probePtyRunningWork(SETTINGS, ['pty-a'], { timeoutMs: 1000 })
    const [idle] = await probePtyRunningWork(SETTINGS, ['pty-b'], { timeoutMs: 1000 })

    expect(live?.verdict).toBe('live')
    expect(idle?.verdict).toBe('exited')
  })
})
