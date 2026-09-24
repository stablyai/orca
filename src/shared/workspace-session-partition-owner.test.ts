import { describe, expect, it } from 'vitest'
import { workspaceSessionPartitionHostId } from './workspace-session-partition-owner'

// Why (#12723): the renderer and the main-process runtime used to get different answers here for
// the same SSH workspace, which split one session across two partitions and left whichever half a
// reader skipped round-tripping as absence (#12721). There is one answer now.
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
