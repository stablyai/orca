import { describe, expect, it } from 'vitest'
import { workspaceHostScopeForVisibleHosts } from './workspace-host-visibility'

describe('workspaceHostScopeForVisibleHosts', () => {
  it('keeps a single visible host as the scope', () => {
    expect(workspaceHostScopeForVisibleHosts(['runtime:devbox'])).toBe('runtime:devbox')
  })

  it('does not keep a hidden single-host scope once several hosts are visible', () => {
    expect(workspaceHostScopeForVisibleHosts(['runtime:devbox', 'local'])).toBe('all')
  })

  it('treats every host visible as all', () => {
    expect(workspaceHostScopeForVisibleHosts(null)).toBe('all')
  })
})
