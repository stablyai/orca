import { describe, expect, it, vi } from 'vitest'
import { applyWorkspaceServerFrame } from './workspace-server-processes'
import type {
  WorkspaceServerInfo,
  WorkspaceServerLogLine
} from '../../../shared/workspace-server-process'
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const info: WorkspaceServerInfo = {
  id: 'run-1',
  worktreeId: 'wt',
  port: 4008,
  name: 'Frontend',
  status: 'running',
  active: true,
  exitCode: null,
  errorCount: 0,
  startedAt: 1
}
const line: WorkspaceServerLogLine = {
  seq: 1,
  time: 0,
  source: 'stdout',
  level: 'info',
  text: 'ready'
}
describe('managed server log frames', () => {
  it('retains log history across state changes and deduplicates replayed lines', () => {
    const first = applyWorkspaceServerFrame([], {
      type: 'update',
      info,
      lines: [line],
      reset: true
    })
    const next = applyWorkspaceServerFrame(first, {
      type: 'update',
      info: { ...info, status: 'stopped' },
      lines: [line],
      reset: false
    })
    expect(next[0]?.logs).toEqual([line])
    expect(next[0]?.status).toBe('stopped')
  })
  it('resets errors and logs only for a new run, ignoring older run updates', () => {
    const current = [{ ...info, id: 'run-2', startedAt: 10, logs: [line] }]
    expect(
      applyWorkspaceServerFrame(current, { type: 'update', info, lines: [], reset: false })
    ).toEqual(current)
    const next = applyWorkspaceServerFrame(current, {
      type: 'update',
      info: { ...info, id: 'run-3', startedAt: 20 },
      lines: [],
      reset: true
    })
    expect(next[0]?.logs).toEqual([])
  })
})
