import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookAttributionDiagnostics } from './agent-hook-attribution-diagnostics'

afterEach(() => vi.restoreAllMocks())

describe('agent hook attribution diagnostics', () => {
  it('suppresses repeated failures while retaining independent owners and later failures', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const diagnostics = new AgentHookAttributionDiagnostics()
    const owner = { paneKey: 'pane', worktreeId: 'folder', connectionId: 'remote-1' }
    expect(diagnostics.shouldReport('unknown_tab_id', owner)).toBe(true)
    for (let index = 0; index < 1_000; index++) {
      expect(diagnostics.shouldReport('unknown_tab_id', owner)).toBe(false)
    }
    expect(diagnostics.shouldReport('unknown_tab_id', { ...owner, connectionId: 'remote-2' })).toBe(
      true
    )
    expect(
      diagnostics.shouldReport('unknown_tab_id', { ...owner, worktreeId: 'other-folder' })
    ).toBe(true)
    expect(diagnostics.shouldReport('empty_pane_key')).toBe(true)
    expect(diagnostics.shouldReport('empty_pane_key')).toBe(false)
    diagnostics.resolved(owner)
    expect(diagnostics.shouldReport('unknown_tab_id', owner)).toBe(true)
    clock.mockReturnValue(1_000 + 5 * 60_000)
    expect(diagnostics.shouldReport('unknown_tab_id', owner)).toBe(true)
    expect(diagnostics.shouldReport('empty_pane_key')).toBe(true)
  })

  it('bounds retained owners without eviction storms and admits failures after cooldown', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const diagnostics = new AgentHookAttributionDiagnostics()
    const reportOwners = () =>
      Array.from({ length: 1_000 }, (_, index) =>
        diagnostics.shouldReport('unknown_tab_id', { paneKey: `pane-${index}` })
      ).filter(Boolean).length
    expect(reportOwners()).toBe(129)
    expect(reportOwners()).toBe(0)
    expect(diagnostics.shouldReport('empty_pane_key')).toBe(true)
    expect(diagnostics.shouldReport('empty_pane_key')).toBe(false)
    clock.mockReturnValue(1_000 + 5 * 60_000)
    expect(reportOwners()).toBe(129)
    expect(reportOwners()).toBe(0)
  })
})
