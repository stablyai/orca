import { describe, expect, it } from 'vitest'
import { getTuiAgentDefaultArgs, resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'

describe('tui agent launch defaults', () => {
  it('launches Droid at High autonomy by default', () => {
    // Why: interactive `droid` ignores unknown options, so a wrong flag would fail silently; pin the exact args.
    expect(getTuiAgentDefaultArgs('droid')).toBe('--auto high')
  })

  it('falls back to the Droid autonomy default when a profile has no Droid entry', () => {
    expect(resolveTuiAgentLaunchArgs('droid', { claude: '--dangerously-skip-permissions' })).toBe(
      '--auto high'
    )
  })

  it('honors an explicit empty Droid entry as a manual launch', () => {
    expect(resolveTuiAgentLaunchArgs('droid', { droid: '' })).toBe('')
  })
})
