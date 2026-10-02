import { describe, expect, it, vi } from 'vitest'
import { getAgentLaunchPlatformForRepo } from './agent-launch-platform'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))

// Why (stack QA P8-6): a pane in a WSL path runs the distro's POSIX shell, so the desktop must plan
// its line for that shell, not for the Windows shell setting.
describe('the platform a desktop launch is planned for', () => {
  it('is the distro for a workspace in a WSL path', () => {
    expect(
      getAgentLaunchPlatformForRepo({
        connectionId: null,
        path: '\\\\wsl.localhost\\qasfwin\\root\\fixture'
      })
    ).toBe('linux')
  })

  it('stays this machine for a native path', () => {
    expect(getAgentLaunchPlatformForRepo({ connectionId: null, path: 'C:\\src\\repo' })).toBe(
      'win32'
    )
  })
})
