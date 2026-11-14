import { describe, expect, it } from 'vitest'
import { WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { pickerContextOffersAgentSetup } from './new-tab-agent-menu-model'

const base = {
  workspace: { kind: 'git-worktree' as const, repoId: 'r1' },
  settings: null,
  key: 'k'
}

describe('pickerContextOffersAgentSetup', () => {
  it('offers setup on this computer', () => {
    expect(pickerContextOffersAgentSetup({ ...base, executionHostId: 'local' })).toBe(true)
  })

  it('offers setup on a paired host that advertises create options', () => {
    expect(
      pickerContextOffersAgentSetup({
        ...base,
        executionHostId: 'runtime:env-1',
        hostCapabilities: [WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY]
      })
    ).toBe(true)
  })

  it('keeps setup off on a paired host without the capability', () => {
    expect(
      pickerContextOffersAgentSetup({
        ...base,
        executionHostId: 'runtime:env-1',
        hostCapabilities: ['another.capability']
      })
    ).toBe(false)
  })

  it('keeps setup off while the host capabilities are unknown', () => {
    expect(
      pickerContextOffersAgentSetup({
        ...base,
        executionHostId: 'runtime:env-1',
        hostCapabilities: null
      })
    ).toBe(false)
  })

  it("does not read an SSH host's local capability list as paired support", () => {
    expect(
      pickerContextOffersAgentSetup({
        ...base,
        executionHostId: 'ssh:conn-1',
        hostCapabilities: [WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY]
      })
    ).toBe(false)
  })

  it('keeps setup off without a picker context', () => {
    expect(pickerContextOffersAgentSetup(undefined)).toBe(false)
  })
})
