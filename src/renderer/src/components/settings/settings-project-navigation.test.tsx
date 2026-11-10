// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useShallow } from 'zustand/react/shallow'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import { ActiveSettingsSectionProvider } from './section-layout/SettingsSection'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList
} from './navigation/settings-project-list'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { buildSettingsViewModel } from './page/settings-view-model'
import type { SettingsNavigationModel } from './navigation/use-settings-navigation-model'
import { renderProjectSettingsSections } from './page/settings-project-section-renderer'
import { useSettingsPageEffects } from './page/use-settings-page-effects'
import type { SettingsRenderContext } from './page/settings-render-context'
import type { SettingsStoreModel } from './page/use-settings-store-model'
import type { SettingsInteractionController } from './page/use-settings-interaction-controller'
import { useSettingsHostNavigation } from './host-scope/use-settings-host-navigation'

vi.mock('./repository/RepositoryPane', () => ({
  RepositoryPane: () => <output>Project pane</output>
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

it.each(['host', 'folder'] as const)(
  'renders and reaches host-qualified legacy links with real %s group IDs',
  (mode) => {
    const base: Repo = {
      id: 'same',
      displayName: 'App',
      path: '/local/app',
      badgeColor: '',
      addedAt: 0,
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/acme/app',
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/acme/app.git'
      }
    }
    const repos: Repo[] = [base, { ...base, path: '/remote/app', executionHostId: 'ssh:box' }]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const settings = { ...getDefaultSettings('/tmp'), projectGroupingMode: mode }
    const entries = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings
    })
    const repoIdToHostSelection = buildRepoIdToHostSelection(entries)
    const repoIdToRepresentative = buildRepoIdToRepresentative(entries)
    const noop = vi.fn()
    const fetch = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ repos, settings })
    let scrollTarget: string | null = null
    function Harness({ hostId }: { hostId: 'local' | 'ssh:box' }) {
      const state = useAppStore(
        useShallow((state) => ({
          repos: state.repos,
          keybindings: state.keybindings,
          updateRepo: state.updateRepo,
          updateProject: state.updateProject,
          settingsProjectHostSelection: state.settingsProjectHostSelection,
          settingsProjectSetupSelection: state.settingsProjectSetupSelection,
          setSettingsProjectHostSelection: state.setSettingsProjectHostSelection
        }))
      )
      const [mounted, setMountedSectionIds] = useState(new Set<string>())
      const [, setPendingNavRequestTick] = useState(0)
      const pendingNavSectionRef = useRef<string | null>(null)
      const pendingScrollTargetRef = useRef<string | null>(null)
      const [target] = useState({
        pane: 'repo',
        repoId: 'same',
        sectionId: 'repo-same',
        hostId
      } as const)
      const { consumeSettingsNavigation } = useSettingsHostNavigation(target)
      const partialModel: Partial<SettingsStoreModel> = {
        ...state,
        settings,
        settingsProjectList: entries,
        repoIdToHostSelection,
        repoIdToRepresentative,
        settingsNavigationTarget: target,
        consumeSettingsNavigation,
        activeSectionId: 'general',
        clearSettingsTarget: noop,
        fetchSettings: fetch,
        fetchKeybindings: fetch,
        showDesktopOnlySettings: false,
        repoHooksMap: {},
        removeProjectAllHosts: fetch,
        setVoiceModelStatesLoading: noop,
        setMountedSectionIds,
        setPendingNavRequestTick,
        setSettingsHostChoice: noop,
        setHighlightedSettingsTarget: noop,
        setGeneralSubPage: noop,
        setQuickCommandAddIntentSignal: noop,
        setRemoteServerAddIntentSignal: noop,
        setSshHostAddIntentSignal: noop
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked model fields supply real page effects and project renderer; inactive unrelated settings sections are not implemented.
      const model = partialModel as SettingsStoreModel
      const partialInteractions: Partial<SettingsInteractionController> = {
        pendingNavSectionRef,
        pendingScrollTargetRef,
        searchInputRef: useRef<HTMLInputElement | null>(null),
        shortcutsEscapeConfirmUntilRef: useRef(0),
        hasUnsavedSourceControlAiPromptChangesRef: useRef(false),
        closeSettingsPageWithPromptGuard: fetch,
        promptDiscardSourceControlAiPromptChanges: fetch
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked pending navigation refs and close/discard callbacks supply real page effects; unrelated interaction methods are not executed.
      const interactions = partialInteractions as SettingsInteractionController
      useSettingsPageEffects(model, interactions)
      scrollTarget = pendingScrollTargetRef.current
      const partialContext: {
        [K in keyof SettingsRenderContext]?: Partial<SettingsRenderContext[K]>
      } = {
        interactions,
        model: {
          ...model,
          settings,
          activeSectionId: pendingNavSectionRef.current ?? model.activeSectionId
        },
        navigation: { getSectionSearchEntries: () => [] },
        terminal: {
          windowsTerminalCapabilities: {
            wslAvailable: false,
            wslDistros: [],
            pwshAvailable: false,
            gitBashAvailable: false,
            hostPlatform: null,
            isLoading: false
          },
          isWindowsTerminalHost: false
        },
        view: { isSectionMounted: (id: string) => mounted.has(id) }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked nested model/navigation/terminal/view port supplies the real project renderer; only RepositoryPane remains the existing component double.
      const context = partialContext as SettingsRenderContext
      return (
        <ActiveSettingsSectionProvider value={pendingNavSectionRef.current}>
          {renderProjectSettingsSections(context)}
        </ActiveSettingsSectionProvider>
      )
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      for (const [hostId, path] of [
        ['local', base.path],
        ['ssh:box', '/remote/app']
      ] as const) {
        act(() => root.render(<Harness key={hostId} hostId={hostId} />))
        const entry = entries.find((candidate) => candidate.representativeHostId === hostId)!
        const id = `repo-${entry.selectionKey}`
        expect(id).toContain('gitlab.com/acme/app')
        expect(document.getElementById(id)?.textContent).toContain(path)
        expect(container.querySelectorAll('section[data-settings-section]')).toHaveLength(1)
        expect(scrollTarget).toBe(id)
        expect(container.textContent).toContain('Project pane')
      }
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  }
)

it('forwards qualified first representative metadata through the shipping navigation and view builder', () => {
  const icon = { type: 'emoji', emoji: '⚓' } as const
  const first: Repo = {
    id: 'same',
    displayName: 'Harbor',
    path: '/ssh/harbor',
    connectionId: 'box',
    badgeColor: '#123456',
    addedAt: 0,
    repoIcon: icon,
    upstream: { owner: 'upstream', repo: 'harbor' }
  }
  const repos = [
    first,
    { ...first, path: '/duplicate', badgeColor: 'wrong' },
    {
      ...first,
      connectionId: undefined,
      executionHostId: 'runtime:other' as const,
      badgeColor: 'foreign'
    }
  ]
  const sections = buildSettingsNavigationMetadata({
    isMac: false,
    isWindows: false,
    isWebClient: false,
    repos
  })
  const partialModel: Pick<
    SettingsStoreModel,
    'repos' | 'settingsSearchQuery' | 'activeSectionId'
  > = {
    repos,
    settingsSearchQuery: '',
    activeSectionId: 'general'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked builder port supplies repos, search and active section; this call does not execute unrelated settings actions.
  const model = partialModel as SettingsStoreModel
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all builder inputs supplied.
  const navigation = {
    visibleNavSections: sections,
    neededSectionIds: new Set(['general'])
  } as SettingsNavigationModel
  const rows = buildSettingsViewModel(model, navigation).repoNavSections
  const ssh = rows.find((row) => row.description.includes('/ssh/harbor')) ?? rows[0]
  expect(ssh).toMatchObject({
    badgeColor: first.badgeColor,
    repoIcon: icon,
    upstream: first.upstream,
    isRemote: true
  })
  const projection = projectHostSetupProjectionFromRepos([first])
  const projectGrouping = { projects: projection.projects, projectHostSetups: projection.setups }
  const duplicate = {
    ...first,
    badgeColor: 'second-exact',
    repoIcon: { type: 'emoji', emoji: '②' } as const
  }
  const foreign = {
    ...first,
    connectionId: undefined,
    executionHostId: 'runtime:other' as const,
    badgeColor: 'foreign'
  }
  for (const catalog of [
    [],
    [foreign],
    [first],
    [duplicate, first],
    [{ ...first, connectionId: undefined }]
  ]) {
    const sections = buildSettingsNavigationMetadata({
      isMac: false,
      isWindows: false,
      isWebClient: false,
      repos: catalog,
      projectGrouping
    })
    const view = buildSettingsViewModel(
      { ...model, repos: catalog },
      { ...navigation, visibleNavSections: sections }
    )
    expect(view.repoNavSections).toHaveLength(1)
    const row = view.repoNavSections[0]
    expect(row.title).toBe('Harbor')
    if (!catalog.length || catalog[0] === foreign) {
      expect(row.repoIcon).toBeUndefined()
      expect(row.badgeColor).toBeUndefined()
      expect(row.upstream).toBeUndefined()
      expect(row.isRemote).toBe(false)
      expect(row.searchEntries.some((entry) => entry.description?.includes('/ssh/harbor'))).toBe(
        true
      )
    } else {
      expect(row.repoIcon).toBe(catalog[0].repoIcon)
      expect(row.badgeColor).toBe(catalog[0].badgeColor)
      expect(row.upstream).toBe(catalog[0].upstream)
      expect(row.isRemote).toBe(Boolean(catalog[0].connectionId))
    }
  }
})
