import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import type { CodexMaintenanceState } from '../../../shared/codex-cli-maintenance'
import {
  invalidateCodexMaintenanceContact,
  getCodexMaintenanceEntry,
  getCodexMaintenanceHostBusy,
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests,
  startCodexMaintenance
} from './codex-maintenance-store'

const { call, refreshAgents } = vi.hoisted(() => ({
  call: vi.fn(),
  refreshAgents: vi.fn().mockResolvedValue([])
}))
vi.mock('./codex-maintenance-client', () => ({
  callCodexMaintenance: call,
  codexMaintenanceTargetKey: (target: { cwd?: string }) =>
    target.cwd ? `local:codex:${target.cwd}` : 'local:codex'
}))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: () => () => {},
    getState: () => ({ refreshDetectedAgents: refreshAgents })
  }
}))
const TARGET = { kind: 'local' } as const
function state(): CodexMaintenanceState {
  return {
    installation: codexCliInstallation(false, null),
    evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
    canRun: true,
    job: null
  }
}
function running(): CodexMaintenanceState {
  return {
    ...state(),
    job: {
      id: 'job',
      phase: 'running',
      output: 'started',
      exitCode: null,
      error: null
    }
  }
}
beforeEach(() => {
  resetCodexMaintenanceStoreForTests()
  call.mockReset()
  refreshAgents.mockClear()
  vi.useFakeTimers()
})
afterEach(() => {
  resetCodexMaintenanceStoreForTests()
  vi.useRealTimers()
})
describe('shared Codex maintenance snapshots', () => {
  it('shares host job activity across workspace contexts while keeping their installation facts separate', async () => {
    const workspace = { kind: 'local', cwd: '/project' } as const
    call.mockResolvedValueOnce(state())
    await refreshCodexMaintenance(TARGET)
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(workspace)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(true)
    const completed = running()
    if (!completed.job) {
      throw new Error('No job')
    }
    completed.job.phase = 'completed'
    completed.currentJob = completed.job
    call.mockResolvedValueOnce(completed).mockResolvedValueOnce(state())
    await vi.advanceTimersByTimeAsync(1000)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(false)
    expect(getCodexMaintenanceEntry('local:codex').state?.job).toBeNull()
  })

  it('ignores an older status response after an explicit start', async () => {
    let completeStatus: (value: CodexMaintenanceState) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          completeStatus = resolve
        })
    )
    const pending = refreshCodexMaintenance(TARGET)
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    completeStatus(state())
    await pending
    expect(getCodexMaintenanceEntry('local:codex').state?.job?.phase).toBe('running')
    expect(getCodexMaintenanceEntry('local:codex').starting).toBe(false)
  })

  it('keeps host-owned job evidence after contact loss and bounds read retries', async () => {
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    call.mockRejectedValue(new Error('Host disconnected'))
    await vi.advanceTimersByTimeAsync(5_000)
    const entry = getCodexMaintenanceEntry('local:codex')
    expect(entry.error).toBe('Host disconnected')
    expect(entry.state?.job?.phase).toBe('running')
    expect(entry.state?.job?.output).toBe('started')
    expect(call.mock.calls.filter(([, params]) => params.operation === 'start')).toHaveLength(1)
    expect(call.mock.calls.filter(([, params]) => params.operation === 'read')).toHaveLength(3)
    expect(refreshAgents).not.toHaveBeenCalled()
    await refreshCodexMaintenance(TARGET)
    expect(getCodexMaintenanceEntry('local:codex').state?.job?.id).toBe('job')
  })

  it('coalesces status requests without starting an install automatically', async () => {
    call.mockResolvedValue(state())
    await Promise.all([refreshCodexMaintenance(TARGET), refreshCodexMaintenance(TARGET)])
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][1]).toEqual({ operation: 'status' })
  })

  it('cancels an error retry poll without stranding a slow explicit start', async () => {
    call.mockResolvedValueOnce(running())
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    call.mockRejectedValueOnce(new Error('Transient read failure'))
    await vi.advanceTimersByTimeAsync(1_000)
    let complete: (result: CodexMaintenanceState) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          complete = resolve
        })
    )
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(call).toHaveBeenCalledTimes(3)
    const result = running()
    if (!result.job) {
      throw new Error('No job')
    }
    result.job.phase = 'completed'
    result.job.exitCode = 1
    complete(result)
    await vi.advanceTimersByTimeAsync(0)
    expect(getCodexMaintenanceEntry('local:codex').starting).toBe(false)
    call.mockResolvedValueOnce(state())
    await refreshCodexMaintenance(TARGET)
    expect(call).toHaveBeenCalledTimes(4)
    call.mockResolvedValueOnce(result)
    startCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toHaveBeenCalledTimes(5)
  })

  it('withdraws stale installation facts while checking and after a failed read, retaining job evidence', async () => {
    call.mockResolvedValueOnce(running())
    await refreshCodexMaintenance(TARGET)
    let rejectRead: (error: Error) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject
        })
    )
    const pending = refreshCodexMaintenance(TARGET)
    expect(getCodexMaintenanceEntry('local:codex').verification).toBe('checking')
    rejectRead(new Error('Host unavailable'))
    await pending
    const entry = getCodexMaintenanceEntry('local:codex')
    expect(entry.verification).toBe('unverifiable')
    expect(entry.state?.job?.output).toBe('started')
    expect(entry.state?.installation.status).toBe('missing')
  })
  it.each(['host restart', 'log expiry', 'another client'])(
    'reconciles disappeared or superseded activity after %s while preserving logs',
    async (scenario) => {
      call.mockResolvedValueOnce(running())
      await refreshCodexMaintenance(TARGET)
      invalidateCodexMaintenanceContact(TARGET)
      const latest = state()
      if (scenario === 'another client') {
        const other = running().job
        if (!other) {
          throw new Error('No job')
        }
        latest.job = { ...other, id: 'job-B', phase: 'completed', exitCode: 1 }
      }
      call.mockResolvedValueOnce(latest)
      await refreshCodexMaintenance(TARGET)
      expect(getCodexMaintenanceHostBusy(TARGET)).toBe(false)
      expect(getCodexMaintenanceEntry('local:codex').logJob?.output).toBe('started')
      call.mockResolvedValueOnce(running())
      startCodexMaintenance(TARGET)
      await vi.advanceTimersByTimeAsync(0)
      expect(call.mock.calls.at(-1)?.[1].operation).toBe('start')
    }
  )

  it('does not let an older log reply restore activity superseded in another context', async () => {
    const workspace = { kind: 'local', cwd: '/project' } as const
    call.mockResolvedValueOnce(running())
    await refreshCodexMaintenance(workspace)
    let completeLog: (value: CodexMaintenanceState) => void = () => {}
    call.mockImplementationOnce(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          completeLog = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(1000)
    call.mockResolvedValueOnce(state())
    await refreshCodexMaintenance(TARGET)
    completeLog({ ...running(), currentJob: running().job })
    await vi.advanceTimersByTimeAsync(0)
    expect(getCodexMaintenanceHostBusy(workspace)).toBe(false)
    expect(call).toHaveBeenCalledTimes(3)
    expect(getCodexMaintenanceEntry('local:codex:/project').logJob?.output).toBe('started')
  })
  it('cancels historical polling when the latest status no longer has that job', async () => {
    call.mockResolvedValueOnce(running())
    await refreshCodexMaintenance(TARGET)
    call.mockResolvedValueOnce(state())
    await refreshCodexMaintenance(TARGET)
    await vi.advanceTimersByTimeAsync(1000)
    expect(call).toHaveBeenCalledTimes(2)
    expect(getCodexMaintenanceHostBusy(TARGET)).toBe(false)
  })
})
