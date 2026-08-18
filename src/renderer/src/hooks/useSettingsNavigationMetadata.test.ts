import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSettingsNavigationMetadata } from './useSettingsNavigationMetadata'
import type { Repo } from '../../../shared/repo-types'

const repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
} satisfies Repo

function ids(
  args: {
    isMac?: boolean
    isWindows?: boolean
    isWebClient?: boolean
    isDev?: boolean
    isLinearConnected?: boolean
  } = {}
): string[] {
  return buildSettingsNavigationMetadata({
    isMac: args.isMac ?? false,
    isWindows: args.isWindows ?? false,
    isWebClient: args.isWebClient ?? false,
    isDev: args.isDev ?? false,
    isLinearConnected: args.isLinearConnected ?? false,
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
      'orca-account',
      'setup-guide',
      'general',
      'integrations',
      'mobile'
    ])
  })

  it('adds the Linear capability section right after Orchestration only when connected', () => {
    expect(ids()).not.toContain('linear')

    const connectedIds = ids({ isLinearConnected: true })
    expect(connectedIds).toContain('linear')
    expect(connectedIds.indexOf('linear')).toBe(connectedIds.indexOf('orchestration') + 1)

    const linearSection = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      isLinearConnected: true,
      repos: [repo]
    }).find((section) => section.id === 'linear')
    expect(linearSection?.group).toBe('capabilities')
  })

  it('keeps the Linear capability section available on web clients when connected', () => {
    expect(ids({ isWebClient: true, isLinearConnected: true })).toContain('linear')
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

  it('places Automations, Artifacts, and Share Skills first under Workflows', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })
    const automations = sections.find((section) => section.id === 'automations')
    const artifacts = sections.find((section) => section.id === 'artifacts')
    const shareSkills = sections.find((section) => section.id === 'share-skills')
    const workflowIds = sections
      .filter((section) => section.group === 'workflows')
      .map((section) => section.id)

    expect(automations?.group).toBe('workflows')
    expect(automations?.searchEntries[0]?.title).toBe('Show Automations Button')
    expect(artifacts?.group).toBe('workflows')
    expect(artifacts?.badge).toBe('Beta')
    expect(artifacts?.description).toBe(
      'Share HTML and Markdown files with your team and manage their public links.'
    )
    expect(shareSkills).toMatchObject({ group: 'workflows', badge: 'Beta' })
    expect(shareSkills?.searchEntries[0]?.title).toBe('Unlisted skill links')
    expect(workflowIds.slice(0, 3)).toEqual(['automations', 'artifacts', 'share-skills'])
  })

  it('places the Orca account in Set Up on desktop only', () => {
    const desktopSections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })
    const account = desktopSections.find((section) => section.id === 'orca-account')

    expect(account?.group).toBe('setup')
    expect(account?.searchEntries[0]?.title).toBe('Orca account')
    expect(ids({ isWebClient: true })).not.toContain('orca-account')
  })

  it('puts web-safe AI capability panes at the top while hiding desktop-only panes', () => {
    expect(ids({ isWebClient: true }).slice(0, 6)).toEqual([
      'agents',
      'accounts',
      'orchestration',
      'setup-guide',
      'general',
      'integrations'
    ])
  })

  it('keeps desktop-only Settings panes out of web metadata', () => {
    const webSections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: true,
      repos: [repo]
    })
    const webIds = webSections.map((section) => section.id)

    expect(webIds).not.toContain('browser')
    expect(webIds).not.toContain('ssh')
    expect(webIds).not.toContain('mobile')
    expect(webIds).not.toContain('computer-use')
    expect(webIds).not.toContain('voice')
    expect(webIds).not.toContain('advanced')
    expect(webIds).toContain('servers')
    expect(webIds).toContain('repo-repo-1')
    const floatingWorkspace = webSections.find((section) => section.id === 'floating-workspace')
    expect(floatingWorkspace?.description).toBe('Global terminal and markdown tabs.')
    expect(floatingWorkspace?.searchEntries.flatMap((entry) => entry.keywords)).not.toContain(
      'browser'
    )
    const shortcuts = webSections.find((section) => section.id === 'shortcuts')
    expect(shortcuts?.searchEntries.map((entry) => entry.title)).not.toContain('New browser tab')
    expect(shortcuts?.searchEntries.map((entry) => entry.title)).not.toContain(
      'New mobile emulator tab'
    )
  })

  it('keeps the Browser shortcut searchable for a capable web runtime', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: true,
      managedBrowserCreationEnabled: true,
      mobileEmulatorCreationEnabled: false,
      repos: [repo]
    })
    const shortcutTitles = sections
      .find((section) => section.id === 'shortcuts')
      ?.searchEntries.map((entry) => entry.title)

    expect(shortcutTitles).toContain('New browser tab')
    expect(shortcutTitles).not.toContain('New mobile emulator tab')
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

  it('places Cloud VM under Experimental instead of as a beta sidebar item', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })
    const experimental = sections.find((section) => section.id === 'experimental')
    const entry = experimental?.searchEntries.find(
      (searchEntry) => searchEntry.title === 'Cloud VM'
    )

    expect(sections.map((section) => section.id)).not.toContain('ephemeral-vms')
    expect(experimental?.group).toBe('experimental')
    expect(entry?.targetSectionId).toBe('ephemeral-vms')
  })

  it('places Plugins under Experimental on desktop and omits it on the web', () => {
    const desktopSections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [repo]
    })
    const desktopIds = desktopSections.map((section) => section.id)

    expect(desktopSections.find((section) => section.id === 'plugins')?.group).toBe('experimental')
    expect(desktopIds.indexOf('plugins')).toBe(desktopIds.indexOf('experimental') + 1)
    expect(ids({ isWebClient: true })).not.toContain('plugins')
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

  it('does not expose local runtime settings from a remote Windows host', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isLocalWindowsHost: false,
      isWindowsTerminalHost: true,
      isWebClient: false,
      repos: [repo]
    })

    const agents = sections.find((section) => section.id === 'agents')
    const general = sections.find((section) => section.id === 'general')
    const terminal = sections.find((section) => section.id === 'terminal')
    const repoSection = sections.find((section) => section.id === 'repo-repo-1')

    expect(agents?.searchEntries.some((entry) => entry.title === 'Agent Runtime')).toBe(false)
    expect(general?.searchEntries.some((entry) => entry.title === 'Default Project Runtime')).toBe(
      false
    )
    expect(terminal?.searchEntries.some((entry) => entry.title === 'Default Shell')).toBe(true)
    expect(repoSection?.searchEntries.some((entry) => entry.title === 'Project Runtime')).toBe(true)
  })

  it('keeps local runtime settings but hides remote Linux entries on a Windows desktop', () => {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: true,
      isLocalWindowsHost: true,
      isWindowsTerminalHost: false,
      isWebClient: false,
      repos: [repo]
    })

    const agents = sections.find((section) => section.id === 'agents')
    const general = sections.find((section) => section.id === 'general')
    const terminal = sections.find((section) => section.id === 'terminal')
    const repoSection = sections.find((section) => section.id === 'repo-repo-1')

    expect(agents?.searchEntries.some((entry) => entry.title === 'Agent Runtime')).toBe(true)
    expect(general?.searchEntries.some((entry) => entry.title === 'Default Project Runtime')).toBe(
      true
    )
    expect(terminal?.searchEntries.some((entry) => entry.title === 'Default Shell')).toBe(false)
    expect(repoSection?.searchEntries.some((entry) => entry.title === 'Project Runtime')).toBe(
      false
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

  it('renders one repo nav section per project even across execution hosts', () => {
    const gitRemote = {
      canonicalKey: 'gitlab.com/acme/app',
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.com:acme/app.git'
    }
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: [
        {
          id: 'local-1',
          path: '/a',
          displayName: 'App',
          badgeColor: '#000',
          addedAt: 0,
          gitRemoteIdentity: gitRemote
        },
        {
          id: 'remote-9',
          path: '/b',
          displayName: 'App',
          badgeColor: '#000',
          addedAt: 0,
          gitRemoteIdentity: gitRemote,
          executionHostId: 'runtime:home-mac'
        }
      ]
    })

    const repoSections = sections.filter((section) => section.id.startsWith('repo-'))
    expect(repoSections).toHaveLength(1)
    expect(repoSections[0].id).toBe('repo-local-1')
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
