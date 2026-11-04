import { describe, expect, it } from 'vitest'
import {
  claudeConfigProfileDirFromEnv,
  normalizeClaudeConfigProfiles
} from './claude-config-profiles'

describe('Claude config profiles', () => {
  it('keeps only rows whose folder can be used verbatim as CLAUDE_CONFIG_DIR', () => {
    expect(
      normalizeClaudeConfigProfiles([
        { id: 'work', label: ' Work ', configDir: '/Users/me/.claude-work' },
        { id: 'tilde', label: 'Tilde', configDir: '~/.claude-tilde' },
        { id: 'relative', label: 'Relative', configDir: '.claude-relative' },
        { id: 'escape', label: 'Escape', configDir: '/Users/me/../other/.claude' },
        { id: 'blank', label: '  ', configDir: '/Users/me/.claude-blank' },
        { id: 'same-folder', label: 'Again', configDir: '/Users/me/.claude-work/' },
        { id: 'work', label: 'Same id', configDir: '/Users/me/.claude-other' },
        { id: 'windows', label: 'Windows', configDir: 'C:\\Users\\me\\.claude-win' },
        { id: 'unc', label: 'Share', configDir: '\\\\server\\share\\claude' },
        { id: 'unc-up', label: 'Share up', configDir: '\\\\server\\share\\..\\other' },
        { id: 'unc-host-only', label: 'Host', configDir: '\\\\server' },
        { id: 'tab', label: 'Tab', configDir: '/Users/me/.claude\tab' }
      ])
    ).toEqual([
      { id: 'work', label: 'Work', configDir: '/Users/me/.claude-work' },
      { id: 'windows', label: 'Windows', configDir: 'C:\\Users\\me\\.claude-win' },
      { id: 'unc', label: 'Share', configDir: '\\\\server\\share\\claude' }
    ])
  })

  it('names a profile folder only when the launch set it as CLAUDE_CONFIG_DIR too', () => {
    expect(
      claudeConfigProfileDirFromEnv({
        CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
        ORCA_CLAUDE_CONFIG_PROFILE_DIR: '/Users/me/.claude-work'
      })
    ).toBe('/Users/me/.claude-work')
    expect(
      claudeConfigProfileDirFromEnv({
        CLAUDE_CONFIG_DIR: '/accounts/selected',
        ORCA_CLAUDE_CONFIG_PROFILE_DIR: '/Users/me/.claude-work'
      })
    ).toBeNull()
  })
})
