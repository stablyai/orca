// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../../shared/repo-types'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../../ui/tooltip'
import { SettingsSidebar } from './SettingsSidebar'
import { getSettingsSectionSearchEntries, rankSettingsSearchItems } from '../search/settings-search'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

const repo: Repo = {
  id: 'app-local',
  displayName: 'App',
  path: '/Users/dev/projects/app',
  badgeColor: '',
  addedAt: 0,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/acme/app',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/acme/app.git'
  },
  upstream: { owner: 'original', repo: 'app' }
}
const repos: Repo[] = [
  repo,
  {
    ...repo,
    id: 'app-remote',
    path: 'C:\\Users\\dev\\src\\second-copy',
    executionHostId: 'ssh:box',
    upstream: undefined
  },
  { id: 'handbook', displayName: 'Handbook', path: '/srv/handbook', badgeColor: '', addedAt: 0 }
]

it.each(['host', 'folder'] as const)(
  'keeps %s copies under one parent and routes each selection to its existing section',
  (mode) => {
    const settings = { ...getDefaultSettings('/tmp'), projectGroupingMode: mode }
    useAppStore.setState({ repos, settings, sshTargetLabels: new Map([['box', 'Build machine']]) })
    const projection = projectHostSetupProjectionFromRepos(repos)
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos,
      projectGrouping: {
        projects: projection.projects,
        projectHostSetups: projection.setups,
        settings
      }
    }).filter((section) => section.id.startsWith('repo-'))
    const local = sections.find(
      (section) => section.projectCopy?.path === '/Users/dev/projects/app'
    )!
    const remote = sections.find(
      (section) => section.projectCopy?.path === 'C:\\Users\\dev\\src\\second-copy'
    )!
    const onSelect = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    function show(active: string, visible = sections) {
      act(() =>
        root.render(
          <TooltipProvider>
            <SettingsSidebar
              activeSectionId={active}
              settings={settings}
              generalGroups={[]}
              repoSections={visible}
              hasRepos
              onBack={() => {}}
              onSelectSection={onSelect}
            />
          </TooltipProvider>
        )
      )
    }
    function button(name: string): HTMLButtonElement {
      return [...container.querySelectorAll('button')].find(
        (row) => row.textContent?.trim() === name
      )!
    }
    try {
      show(remote.id)
      expect(
        [...container.querySelectorAll('button')].map((row) => row.textContent?.trim())
      ).toEqual([
        'Back to app',
        'App',
        'app~/projects/app',
        'second-copy~\\src\\second-copy',
        'Handbook'
      ])
      expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
      expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(
        'second-copy~\\src\\second-copy'
      )
      expect(container.querySelector('[aria-label="Build machine"]')).not.toBeNull()
      expect(container.querySelectorAll('[aria-label="Fork of original/app"]')).toHaveLength(1)
      expect(container.textContent).not.toContain('SSH')
      act(() => button('App').click())
      expect(onSelect).toHaveBeenLastCalledWith(remote.id)
      act(() => button('app~/projects/app').click())
      expect(onSelect).toHaveBeenLastCalledWith(local.id)
      show('general')
      act(() => button('App').click())
      expect(onSelect).toHaveBeenLastCalledWith(local.id)
      const matches = rankSettingsSearchItems(
        'second-copy',
        sections,
        getSettingsSectionSearchEntries
      ).map(({ item }) => item)
      expect(matches.map((section) => section.id)).toEqual([remote.id])
      show('general', matches)
      expect(button('App')).toBeDefined()
      act(() => button('second-copy~\\src\\second-copy').click())
      expect(onSelect).toHaveBeenLastCalledWith(remote.id)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  }
)

it('keeps repository mode and a single checkout as ordinary project rows', () => {
  const settings = { ...getDefaultSettings('/tmp'), projectGroupingMode: 'repository' as const }
  useAppStore.setState({ repos, settings })
  const projection = projectHostSetupProjectionFromRepos(repos)
  const sections = buildSettingsNavigationMetadata({
    isMac: false,
    isWindows: false,
    isWebClient: false,
    repos,
    projectGrouping: {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings
    }
  }).filter((section) => section.id.startsWith('repo-'))
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <TooltipProvider>
          <SettingsSidebar
            activeSectionId={sections[0].id}
            settings={settings}
            generalGroups={[]}
            repoSections={sections}
            hasRepos
            onBack={() => {}}
            onSelectSection={() => {}}
          />
        </TooltipProvider>
      )
    )
    expect([...container.querySelectorAll('button')].map((row) => row.textContent?.trim())).toEqual(
      ['Back to app', 'App', 'Handbook']
    )
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('App')
  } finally {
    act(() => root.unmount())
  }
})
