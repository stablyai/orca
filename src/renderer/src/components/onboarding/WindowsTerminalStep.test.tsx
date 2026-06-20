import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import type { GlobalSettings } from '../../../../shared/types'
import { WindowsTerminalStep } from './WindowsTerminalStep'

function createSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsWslDistro: null,
    terminalRightClickToPaste: true,
    ...overrides
  } as GlobalSettings
}

describe('WindowsTerminalStep', () => {
  it('renders default shell and right-click behavior choices', () => {
    const html = renderToStaticMarkup(
      <WindowsTerminalStep settings={createSettings()} updateSettings={vi.fn()} />
    )

    expect(html).toContain('Default Shell')
    expect(html).toContain('PowerShell')
    expect(html).toContain('Command Prompt')
    expect(html).toContain('Right-click behavior')
    expect(html).toContain('Paste on right-click')
    expect(html).toContain('Open context menu')
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('fill="#2E74B5"')
    expect(html).not.toContain('lucide-terminal')
  })

  it('keeps the WSL distro control visible when WSL is already selected', () => {
    const html = renderToStaticMarkup(
      <WindowsTerminalStep
        settings={createSettings({
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian'
        })}
        updateSettings={vi.fn()}
      />
    )

    expect(html).toContain('WSL')
    expect(html).toContain('WSL Distribution')
  })

  it('renders Git Bash with the Git Bash mark instead of a text badge', () => {
    const html = renderToStaticMarkup(
      <WindowsTerminalStep
        settings={createSettings({
          terminalWindowsShell: WINDOWS_GIT_BASH_SHELL
        })}
        updateSettings={vi.fn()}
      />
    )

    expect(html).toContain('Git Bash')
    expect(html).toContain('gwindows_logo.svg')
    expect(html).not.toContain('&gt;Git&lt;')
    expect(html).not.toContain('>Git<')
  })
})
