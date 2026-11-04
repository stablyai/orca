import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  wslHostStatuses: { 'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' } },
  unavailable: false
}))

vi.mock('@/store', () => ({
  useAppStore: <T>(selector: (current: typeof state) => T) => selector(state)
}))
vi.mock('./remote-server-outage', () => ({
  selectWorkspaceRuntimeEnvironmentId: () => 'wsl:ubuntu'
}))
vi.mock('./use-wsl-host-unavailable-reason', () => ({
  selectWslHostUnavailableReason: (current: typeof state) =>
    current.unavailable ? 'turned-off' : null
}))

import { useWslHostStartCardReplacesPaneError } from './use-wsl-host-stopped-pane'

describe('the stopped distro card replacing the pane error toast', () => {
  it('replaces it on the stopped host and on a pane that has no server yet', () => {
    expect(useWslHostStartCardReplacesPaneError('wt-1', 'wsl:ubuntu')).toBe(true)
    expect(useWslHostStartCardReplacesPaneError('wt-1', null)).toBe(true)
  })

  it('keeps the real error on a pane of another server, or with no active pane', () => {
    expect(useWslHostStartCardReplacesPaneError('wt-1', 'ssh:desk')).toBe(false)
    expect(useWslHostStartCardReplacesPaneError('wt-1', undefined)).toBe(false)
  })

  it('keeps the real error when WSL hosts cannot run', () => {
    state.unavailable = true
    try {
      expect(useWslHostStartCardReplacesPaneError('wt-1', 'wsl:ubuntu')).toBe(false)
    } finally {
      state.unavailable = false
    }
  })
})
