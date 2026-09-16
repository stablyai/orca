import { describe, expect, it } from 'vitest'
import { workspaceSessionPartitionHostId } from './workspace-session-partition-owner'

// Why (#12723): the renderer and the runtime used two independent owner maps for the same
// worktree's session state. They now share one function, so the divergence is a single argument
// and cannot drift further. Behaviour on both sides is unchanged.
describe('workspaceSessionPartitionHostId', () => {
  it('keeps runtime worktrees in their own partition on both sides', () => {
    expect(workspaceSessionPartitionHostId('runtime:env-a', 'local-partition')).toBe(
      'runtime:env-a'
    )
    expect(workspaceSessionPartitionHostId('runtime:env-a', 'host-partition')).toBe('runtime:env-a')
  })

  it('keeps local worktrees local on both sides', () => {
    expect(workspaceSessionPartitionHostId('local', 'local-partition')).toBe('local')
    expect(workspaceSessionPartitionHostId('local', 'host-partition')).toBe('local')
  })

  it('records the SSH divergence as the only difference between the two models', () => {
    expect(workspaceSessionPartitionHostId('ssh:devbox', 'local-partition')).toBe('local')
    expect(workspaceSessionPartitionHostId('ssh:devbox', 'host-partition')).toBe('ssh:devbox')
  })

  it('falls back to the local partition for unparseable host ids', () => {
    expect(workspaceSessionPartitionHostId(null, 'host-partition')).toBe('local')
    expect(workspaceSessionPartitionHostId('nonsense', 'host-partition')).toBe('local')
  })
})
