import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

function ids(
  args: { isMac?: boolean; isWindows?: boolean; isWebClient?: boolean; isDev?: boolean } = {}
): string[] {
  return buildSettingsNavigationMetadata({
    isMac: args.isMac ?? false,
    isWindows: args.isWindows ?? false,
    isWebClient: args.isWebClient ?? false,
    isDev: args.isDev ?? false,
    repos: [repo]
  }).map((section) => section.id)
}

describe('settings navigation metadata', () => {
  it('puts AI capability panes at the top on desktop', () => {
    expect(ids().slice(0, 10)).toEqual([
      'agents',
      'accounts',
      'orchestration',
      'computer-use',
      'voice',
      'setup-guide',
      'general',
      'integrations',
      'mobile',
      'git'
    ])
  })

  it('places Mobile under Set Up instead of its own sidebar group', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })

    expect(sections.find((section) => section.id === 'mobile')?.group).toBe('setup')
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

  it('places per-workspace environments under Experimental instead of as a beta sidebar item', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })
    const experimental = sections.find((section) => section.id === 'experimental')
    const entry = experimental?.searchEntries.find(
      (searchEntry) => searchEntry.title === 'Per-Workspace Environments'
    )

    expect(sections.map((section) => section.id)).not.toContain('ephemeral-vms')
    expect(experimental?.group).toBe('experimental')
    expect(entry?.targetSectionId).toBe('ephemeral-vms')
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

  it('surfaces Windows-host and universal terminal settings in Windows-host metadata', () => {
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
    // Right-click to paste is now exposed on every platform (#8322), so it is
    // indexed even when only the terminal host — not the client — is Windows.
    expect(terminal?.searchEntries.some((entry) => entry.title === 'Right-click to paste')).toBe(
      true
    )
  })

  it('places Advanced near the bottom on desktop without putting it under Experimental', () => {
    const desktopIds = ids()

    expect(desktopIds).toContain('advanced')
    expect(desktopIds.indexOf('advanced')).toBeLessThan(desktopIds.indexOf('experimental'))
    expect(desktopIds.indexOf('privacy')).toBeLessThan(desktopIds.indexOf('advanced'))
  })

  // Note: this exercises the isDev parameter and isWebClient branches only.
  // Production safety rests on the hard `import.meta.env.DEV` term in the
  // builder, which is compile-time-inlined per build and cannot be flipped from
  // a test (vitest always runs with DEV=true) — don't mistake this for full
  // prod-gate coverage. The bundle exclusion is what guarantees prod safety.
  it('shows Dev tools only in desktop development metadata', () => {
    expect(ids()).not.toContain('dev')
    expect(ids({ isDev: true })).toContain('dev')
    expect(ids({ isDev: true, isWebClient: true })).not.toContain('dev')
  })

  it('keeps macOS permissions mac-only', () => {
    expect(ids({ isMac: false })).not.toContain('developer-permissions')
    expect(ids({ isMac: true })).toContain('developer-permissions')
  })

  it('does not import Settings page or pane UI modules from the metadata hook', () => {
    const testDir = import.meta.dirname
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
    const testDir = import.meta.dirname
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
