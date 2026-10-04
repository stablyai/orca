import { describe, expect, it } from 'vitest'
import { parseQuickOpenInstallRgGuidance } from './quick-open-install-rg-guidance'

describe('parseQuickOpenInstallRgGuidance', () => {
  it('parses the remote message into a copyable command', () => {
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (File listing exceeded 10000 files). Install ripgrep on the remote to enable fast, gitignore-aware listing: sudo apt install ripgrep'
      )
    ).toEqual({
      reason: 'File listing exceeded 10000 files',
      command: 'sudo apt install ripgrep',
      guidance: null
    })
  })

  it('renders generic install prose through the guidance path', () => {
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (File listing timed out). Install ripgrep on the remote to enable fast, gitignore-aware listing: install ripgrep via your package manager (e.g. apt/dnf/pacman)'
      )
    ).toEqual({
      reason: 'File listing timed out',
      command: null,
      guidance: 'install ripgrep via your package manager (e.g. apt/dnf/pacman)'
    })
  })

  // Why: only a remote host can still reach the capped fallback, so the old local wording is
  // no longer produced anywhere and falls through to plain-text display.
  it('returns null for the retired local wording and for regular errors', () => {
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (File listing timed out). Install ripgrep on the host running the Quick Open scan to enable fast, gitignore-aware listing: brew install ripgrep'
      )
    ).toBeNull()
    expect(parseQuickOpenInstallRgGuidance('git ls-files exited with code 128')).toBeNull()
  })
})
