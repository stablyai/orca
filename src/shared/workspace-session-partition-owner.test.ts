import { describe, expect, it } from 'vitest'
import { workspaceSessionPartitionHostId } from './workspace-session-partition-owner'

// Divergent renderer/runtime ownership split SSH sessions, making unread rows round-trip as deletion (#12723, #12721).
describe('workspaceSessionPartitionHostId', () => {
  it('gives a runtime host its own partition', () => {
    expect(workspaceSessionPartitionHostId('runtime:env-a')).toBe('runtime:env-a')
  })

  it('gives an SSH host its own partition, matching what the runtime already writes', () => {
    expect(workspaceSessionPartitionHostId('ssh:devbox')).toBe('ssh:devbox')
  })

  it('keeps local state in the legacy local blob', () => {
    expect(workspaceSessionPartitionHostId('local')).toBe('local')
  })

  it('falls back to the local partition for unparseable host ids', () => {
    expect(workspaceSessionPartitionHostId(null)).toBe('local')
    expect(workspaceSessionPartitionHostId('nonsense')).toBe('local')
  })
})
