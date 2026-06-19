import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSettingsNavigationMetadata } from './useSettingsNavigationMetadata'
import type { Repo } from '../../../shared/types'

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
} satisfies Repo

function ids(args: { isMac?: boolean; isWindows?: boolean; isWebClient?: boolean } = {}): string[] {
  return buildSettingsNavigationMetadata({
    isMac: args.isMac ?? false,
    isWindows: args.isWindows ?? false,
    isWebClient: args.isWebClient ?? false,
    repos: [repo]
  }).map((section) => section.id)
}

describe('settings navigation metadata', () => {
  it('puts AI capability panes at the top on desktop', () => {
    expect(ids().slice(0, 9)).toEqual([
      'agents',
      'accounts',
      'orchestration',
      'computer-use',
      'voice',
      'setup-guide',
      'general',
      'integrations',
      'git'
    ])
  })

  it('puts web-safe AI capability panes at the top while hiding desktop-only panes', () => {
    expect(ids({ isWebClient: true }).slice(0, 7)).toEqual([
      'agents',
      'accounts',
      'orchestration',
      'setup-guide',
      'general',
      'integrations',
      'git'
    ])
  })

  it('keeps desktop-only Settings panes out of web metadata', () => {
    const webIds = ids({ isWebClient: true })

    expect(webIds).not.toContain('browser')
    expect(webIds).not.toContain('ssh')
    expect(webIds).not.toContain('mobile')
    expect(webIds).not.toContain('computer-use')
    expect(webIds).not.toContain('voice')
    expect(webIds).not.toContain('advanced')
    expect(webIds).toContain('servers')
    expect(webIds).toContain('repo-repo-1')
  })

  it('does not mark installable AI capabilities as beta in the sidebar metadata', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: true,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })

    expect(sections.find((section) => section.id === 'computer-use')?.badge).toBeUndefined()
    expect(sections.find((section) => section.id === 'voice')?.badge).toBeUndefined()
  })

  it('omits Windows project runtime search entries when the active host is unsupported', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWindowsTerminalHost: false,
      isWebClient: false,
      repos: [repo]
    })

    const general = sections.find((section) => section.id === 'general')
    const repoSection = sections.find((section) => section.id === 'repo-repo-1')

    expect(general?.searchEntries.some((entry) => entry.title === 'Default Project Runtime')).toBe(
      false
    )
    expect(repoSection?.searchEntries.some((entry) => entry.title === 'Project Runtime')).toBe(
      false
    )
  })

  it('includes project runtime search entries for local repos on Windows hosts', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: true,
      isWebClient: false,
      repos: [repo]
    })

    const general = sections.find((section) => section.id === 'general')
    const repoSection = sections.find((section) => section.id === 'repo-repo-1')

    expect(general?.searchEntries.some((entry) => entry.title === 'Default Project Runtime')).toBe(
      true
    )
    expect(repoSection?.searchEntries.some((entry) => entry.title === 'Project Runtime')).toBe(true)
  })

  it('keeps Windows client-only terminal settings out of Windows-host metadata', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWindowsTerminalHost: true,
      isWebClient: false,
      repos: [repo]
    })

    const terminal = sections.find((section) => section.id === 'terminal')

    expect(terminal?.searchEntries.some((entry) => entry.title === 'Default Shell')).toBe(true)
    expect(terminal?.searchEntries.some((entry) => entry.title === 'PowerShell Version')).toBe(true)
    expect(terminal?.searchEntries.some((entry) => entry.title === 'Right-click to paste')).toBe(
      false
    )
  })

  it('places Advanced near the bottom on desktop without putting it under Experimental', () => {
    const desktopIds = ids()

    expect(desktopIds).toContain('advanced')
    expect(desktopIds.indexOf('advanced')).toBeLessThan(desktopIds.indexOf('experimental'))
    expect(desktopIds.indexOf('privacy')).toBeLessThan(desktopIds.indexOf('advanced'))
  })

  it('keeps macOS permissions mac-only', () => {
    expect(ids({ isMac: false })).not.toContain('developer-permissions')
    expect(ids({ isMac: true })).toContain('developer-permissions')
  })

  it('does not import Settings page or pane UI modules from the metadata hook', () => {
    const testDir = dirname(fileURLToPath(import.meta.url))
    const hookSource = readFileSync(resolve(testDir, 'useSettingsNavigationMetadata.ts'), 'utf8')
    const importLines = hookSource
      .split('\n')
      .filter((line) => line.trim().startsWith('import '))
      .join('\n')

    expect(importLines).not.toMatch(/components\/settings\/Settings(?:'|")/)
    expect(importLines).not.toMatch(/components\/settings\/[A-Z][A-Za-z]+Pane(?:'|")/)
    expect(importLines).not.toMatch(/components\/stats\/StatsPane(?:'|")/)
  })

  it('does not import Settings page or pane UI modules from the quick action registry', () => {
    const testDir = dirname(fileURLToPath(import.meta.url))
    const registrySource = readFileSync(
      resolve(testDir, '../components/cmd-j/quick-actions.ts'),
      'utf8'
    )
    const importLines = registrySource
      .split('\n')
      .filter((line) => line.trim().startsWith('import '))
      .join('\n')

    expect(importLines).not.toMatch(/components\/settings\/Settings(?:'|")/)
    expect(importLines).not.toMatch(/components\/settings\/[A-Z][A-Za-z]+Pane(?:'|")/)
    expect(importLines).not.toMatch(/components\/stats\/StatsPane(?:'|")/)
  })
})
