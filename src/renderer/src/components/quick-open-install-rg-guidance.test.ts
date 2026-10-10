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

  it.each(['on the host running the Quick Open scan', 'on this machine', 'on the remote'])(
    'accepts legacy peer guidance with nested parentheses: %s',
    (host) => {
      expect(
        parseQuickOpenInstallRgGuidance(
          `Quick Open scan too large (File listing failed (exit 127)). Install ripgrep ${host} to enable fast, gitignore-aware listing: brew install ripgrep`
        )
      ).toEqual({
        reason: 'File listing failed (exit 127)',
        command: 'brew install ripgrep',
        guidance: null
      })
    }
  )
  it('leaves unrelated errors and unrecognized wording as plain text', () => {
    expect(parseQuickOpenInstallRgGuidance('git ls-files exited with code 128')).toBeNull()
    expect(
      parseQuickOpenInstallRgGuidance(
        'Quick Open scan too large (reason). Install ripgrep somewhere: sudo apt install ripgrep'
      )
    ).toBeNull()
  })
})
