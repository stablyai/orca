import { describe, expect, it } from 'vitest'
import {
  workspaceHostScopeForVisibleHosts,
  type WorkspaceHostRowLike
} from './workspace-host-visibility'

describe('workspaceHostScopeForVisibleHosts', () => {
  it('keeps a single visible host as the scope', () => {
    expect(workspaceHostScopeForVisibleHosts(['runtime:devbox'])).toBe('runtime:devbox')
  })

  it('does not keep a hidden single-host scope once several hosts are visible', () => {
    expect(workspaceHostScopeForVisibleHosts(['runtime:devbox', 'local'])).toBe('all')
  })

  it('keeps the scope of one merged row that saves several equivalent host IDs', () => {
    const rows: WorkspaceHostRowLike[] = [
      { id: 'ssh:win-vm', aliasHostIds: ['runtime:env-1'] },
      { id: 'local' }
    ]
    expect(workspaceHostScopeForVisibleHosts(['ssh:win-vm', 'runtime:env-1'], rows)).toBe(
      'ssh:win-vm'
    )
    expect(workspaceHostScopeForVisibleHosts(['ssh:win-vm', 'runtime:env-1', 'local'], rows)).toBe(
      'all'
    )
  })

  it('ignores rows a managed host merged away when counting visible host rows', () => {
    const rows: WorkspaceHostRowLike[] = [
      { id: 'ssh:win-vm', aliasHostIds: ['runtime:env-1'] },
      { id: 'runtime:env-1', mergedIntoHostId: 'ssh:win-vm' }
    ]
    expect(workspaceHostScopeForVisibleHosts(['ssh:win-vm', 'runtime:env-1'], rows)).toBe(
      'ssh:win-vm'
    )
  })

  it('treats every host visible as all', () => {
    expect(workspaceHostScopeForVisibleHosts(null)).toBe('all')
  })
})
