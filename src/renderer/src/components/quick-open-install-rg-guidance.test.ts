import { describe, expect, it } from 'vitest'
import { parseQuickOpenInstallRgGuidance } from './quick-open-install-rg-guidance'

describe('parseQuickOpenInstallRgGuidance', () => {
  it('parses the local message and reports the local location', () => {
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (File listing timed out). Install ripgrep on the host running the Quick Open scan to enable fast, gitignore-aware listing: brew install ripgrep'
      )
    ).toEqual({
      reason: 'File listing timed out',
      location: 'local',
      command: 'brew install ripgrep',
      guidance: null
    })
  })

  it('keeps parsing the legacy remote message and reports the remote location', () => {
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (File listing exceeded 10000 files). Install ripgrep on the remote to enable fast, gitignore-aware listing: sudo apt install ripgrep'
      )
    ).toEqual({
      reason: 'File listing exceeded 10000 files',
      location: 'remote',
      command: 'sudo apt install ripgrep',
      guidance: null
    })
  })

  it('renders generic install prose through the guidance path', () => {
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (File listing timed out). Install ripgrep on the host running the Quick Open scan to enable fast, gitignore-aware listing: install ripgrep via your package manager (e.g. apt/dnf/pacman)'
      )
    ).toEqual({
      reason: 'File listing timed out',
      location: 'local',
      command: null,
      guidance: 'install ripgrep via your package manager (e.g. apt/dnf/pacman)'
    })
  })

  it('returns null for regular errors', () => {
    expect(parseQuickOpenInstallRgGuidance('git ls-files exited with code 128')).toBeNull()
  })
})
