import { describe, expect, it } from 'vitest'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host/execution-host-registry-entry'
import { needsVisibleRunTargetHost } from './run-target-host-visibility'

const hosts: ExecutionHostRegistryEntry[] = [
  { id: 'local', kind: 'local', label: 'Local Mac', detail: 'This computer', health: 'local' },
  {
    id: 'runtime:vm-1',
    kind: 'runtime',
    label: 'app VM',
    detail: 'Orca server',
    health: 'available',
    source: 'ephemeral-vm'
  },
  {
    id: 'runtime:build-box',
    kind: 'runtime',
    label: 'Build box',
    detail: 'Orca server',
    health: 'available',
    source: 'manual'
  }
]

describe('needsVisibleRunTargetHost', () => {
  it('holds Create only for a per-workspace VM target, which Run on never lists', () => {
    const on = (hostId: 'local' | `runtime:${string}`) => ({
      status: 'ready' as const,
      target: { hostId }
    })
    expect(needsVisibleRunTargetHost(on('runtime:vm-1'), hosts, null)).toBe(true)
    expect(needsVisibleRunTargetHost(on('runtime:build-box'), hosts, null)).toBe(false)
    expect(needsVisibleRunTargetHost(on('local'), hosts, null)).toBe(false)
  })
})
