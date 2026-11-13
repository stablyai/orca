import { beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '../../../store/types'
import { canOwnerResolveSleepingAgentId } from './sleeping-agent-id-owner'

type OwnerFacts = {
  target: { kind: 'local' } | { kind: 'environment'; environmentId: string } | null
  capability: boolean | null
  platform: { kind: 'known'; platform: string } | { kind: 'withheld' }
}
const owner = vi.hoisted((): OwnerFacts => ({
  target: null,
  capability: null,
  platform: { kind: 'withheld' }
}))
vi.mock('../../../store/slices/worktrees/listing/worktree-owner-target', () => ({
  tryRuntimeTargetForWorktreeOwner: () => owner.target
}))
vi.mock('../../../runtime/rpc/compatibility/runtime-compatibility-cache', () => ({
  readCachedRuntimeEnvironmentCapability: () => owner.capability
}))
vi.mock('../../../runtime/hosts/platform/execution-host-facts', () => ({
  resolveWorktreeExecutionHostPlatform: () => owner.platform
}))

const state: AppState = Object.create(null)
beforeEach(() => {
  owner.target = { kind: 'environment', environmentId: 'paired' }
  owner.capability = true
  owner.platform = { kind: 'known', platform: 'linux' }
})

it('offers a sleeping pane only where its remote owner answers and can resolve the record', () => {
  expect(canOwnerResolveSleepingAgentId(state, 'wt')).toBe(true)
  // An older owner without terminal.agentId, or one whose status has not been read yet.
  owner.capability = false
  expect(canOwnerResolveSleepingAgentId(state, 'wt')).toBe(false)
  owner.capability = null
  expect(canOwnerResolveSleepingAgentId(state, 'wt')).toBe(false)
  owner.capability = true
  // A Windows owner's sleep record names no WSL distro; an unknown OS fails closed.
  owner.platform = { kind: 'known', platform: 'win32' }
  expect(canOwnerResolveSleepingAgentId(state, 'wt')).toBe(false)
  owner.platform = { kind: 'withheld' }
  expect(canOwnerResolveSleepingAgentId(state, 'wt')).toBe(false)
  owner.target = null
  expect(canOwnerResolveSleepingAgentId(state, 'wt')).toBe(false)
})
