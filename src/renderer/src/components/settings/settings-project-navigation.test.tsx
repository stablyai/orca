// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import * as repoLookups from '@/lib/project-setup-repo-lookup'
import { SettingsSidebar } from './SettingsSidebar'
import { TooltipProvider } from '../ui/tooltip'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useShallow } from 'zustand/react/shallow'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList
} from './settings-project-list'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { buildSettingsViewModel } from './settings-view-model'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import { renderProjectSettingsSections } from './settings-project-section-renderer'
import { useSettingsPageEffects } from './use-settings-page-effects'
import type { SettingsRenderContext } from './settings-render-context'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'

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
      const partialModel: Partial<SettingsStoreModel> = {
        ...state,
        settings,
        settingsProjectList: entries,
        repoIdToHostSelection,
        repoIdToRepresentative,
        settingsNavigationTarget: target,
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
        setHighlightedSettingsTargetId: noop,
        setQuickCommandAddIntentSignal: noop,
        setRemoteServerAddIntentSignal: noop,
        setSshHostAddIntentSignal: noop
      }
      // SAFETY: this existing boundary fixture supplies the fields consumed below.
      // oxlint-disable-next-line typescript/consistent-type-assertions
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
      // SAFETY: unrelated interactions are outside this fixture boundary.
      // oxlint-disable-next-line typescript/consistent-type-assertions
      const interactions = partialInteractions as SettingsInteractionController
      useSettingsPageEffects(model, interactions)
      scrollTarget = pendingScrollTargetRef.current
      const partialContext: {
        [K in keyof SettingsRenderContext]?: Partial<SettingsRenderContext[K]>
      } = {
        model: {
          ...model,
          settings,
          activeSectionId: pendingNavSectionRef.current ?? model.activeSectionId
        },
        navigation: { getSectionSearchEntries: () => [] },
        terminal: {
          // SAFETY: the existing mocked RepositoryPane does not consume capability values.
          // oxlint-disable-next-line typescript/consistent-type-assertions
          windowsTerminalCapabilities:
            {} as SettingsRenderContext['terminal']['windowsTerminalCapabilities'],
          isWindowsTerminalHost: false
        },
        view: { isSectionMounted: (id: string) => mounted.has(id) }
      }
      // SAFETY: only the project-section renderer is exercised by this existing boundary fixture.
      // oxlint-disable-next-line typescript/consistent-type-assertions
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
  const partialModel: Partial<SettingsStoreModel> = {
    repos,
    settingsSearchQuery: '',
    activeSectionId: 'general'
  }
  // SAFETY: this existing boundary fixture supplies the fields consumed below.
  // oxlint-disable-next-line typescript/consistent-type-assertions
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

it('measures qualified preparation and actual view forwarding with independent catalog and section populations', () => {
  const experiments = [
    { name: 'R', r: 100, mode: 'repository', s: 100 },
    { name: 'R', r: 1000, mode: 'repository', s: 100 },
    { name: 'S', r: 1000, mode: 'repository', s: 100 },
    { name: 'S', r: 1000, mode: 'folder', s: 1000 },
    { name: 'diagonal', r: 100, mode: 'folder', s: 100 },
    { name: 'diagonal', r: 1000, mode: 'folder', s: 1000 }
  ] as const
  for (const experiment of experiments) {
    let phase = ''
    const counters = {
      catalogVisits: 0,
      lookupPreparations: 0,
      lookupQueries: 0,
      sectionProjections: 0,
      builderRawComparisons: 0,
      builderIdReads: 0
    }
    const plain: Repo[] = Array.from({ length: experiment.r }, (_, i) => ({
      id: `settings-${i}`,
      displayName: `Settings ${i % 100}`,
      path: `/settings/${i}`,
      badgeColor: `color-${i}`,
      repoIcon: { type: 'emoji', emoji: `icon-${i}` },
      connectionId: 'box',
      addedAt: 0,
      upstream: { owner: 'upstream', repo: `repo-${i % 100}` },
      gitRemoteIdentity: {
        canonicalKey: `github.com/org/project-${i % 100}`,
        remoteName: 'origin',
        remoteUrl: `https://github.com/org/project-${i % 100}`
      }
    }))
    const projection = projectHostSetupProjectionFromRepos(plain)
    const grouping = {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { projectGroupingMode: experiment.mode }
    }
    const observed = plain.map((repo) => ({
      ...repo,
      get badgeColor() {
        if (phase === 'nav') {
          counters.sectionProjections++
        }
        return repo.badgeColor
      }
    }))
    function observe(rows: Repo[]): Repo[] {
      const counted = [...rows]
      Object.defineProperties(counted, {
        [Symbol.iterator]: {
          value: function* () {
            for (const row of rows) {
              if (phase === 'lookup') {
                counters.catalogVisits++
              }
              yield row
            }
          }
        },
        find: {
          value: (predicate: (row: Repo) => boolean) =>
            rows.find((row) => {
              if (phase === 'builder') {
                counters.builderRawComparisons++
              }
              return predicate(row)
            })
        }
      })
      return counted
    }
    const repos = observe(observed)
    const actualLookup = repoLookups.buildProjectSetupRepoLookup
    const wrapped = new WeakSet<object>()
    const querySpies: (() => void)[] = []
    const lookupSpy = vi
      .spyOn(repoLookups, 'buildProjectSetupRepoLookup')
      .mockImplementation((rows) => {
        phase = 'lookup'
        const before = counters.catalogVisits
        const lookup = actualLookup(rows)
        if (counters.catalogVisits > before) {
          counters.lookupPreparations++
        }
        phase = 'nav'
        if (!wrapped.has(lookup)) {
          wrapped.add(lookup)
          const resolve = lookup.resolve
          const spy = vi.spyOn(lookup, 'resolve').mockImplementation((setup) => {
            counters.lookupQueries++
            return resolve(setup)
          })
          querySpies.push(() => spy.mockRestore())
        }
        return lookup
      })
    try {
      const run = (catalog: Repo[], query: string, pass: string) => {
        const before = { ...counters }
        phase = 'nav'
        const sections = buildSettingsNavigationMetadata({
          isMac: false,
          isWindows: false,
          isWebClient: false,
          repos: catalog,
          projectGrouping: grouping
        })
        phase = ''
        const projectRows = sections.filter((row) => row.id.startsWith('repo-'))
        expect(projectRows).toHaveLength(experiment.s)
        const expected = buildSettingsProjectList(catalog, grouping)
        for (let i = 0; i < projectRows.length; i++) {
          const representative = catalog.find(
            (repo) => repo.id === expected[i].representativeRepoId
          )!
          expect(projectRows[i]).toMatchObject({
            repoIcon: representative.repoIcon,
            badgeColor: representative.badgeColor,
            upstream: representative.upstream,
            isRemote: true
          })
        }
        const visible = sections
          .filter((row) => !query || row.title === query)
          .map((row) => ({
            ...row,
            get id() {
              if (phase === 'builder') {
                counters.builderIdReads++
              }
              return row.id
            }
          }))
        const partialModel: Partial<SettingsStoreModel> = {
          repos: catalog,
          settingsSearchQuery: query,
          activeSectionId: 'general'
        }
        // SAFETY: this existing boundary fixture supplies the fields consumed below.
        // oxlint-disable-next-line typescript/consistent-type-assertions
        const model = partialModel as SettingsStoreModel
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: builder's exact read fields supplied.
        const navigation = {
          visibleNavSections: visible,
          neededSectionIds: new Set(['general'])
        } as SettingsNavigationModel
        phase = 'builder'
        const view = buildSettingsViewModel(model, navigation)
        phase = ''
        expect(view.repoNavSections.length).toBe(
          query
            ? expected.filter((row) => (row.checkoutLabel ?? row.project.displayName) === query)
                .length
            : experiment.s
        )
        for (const row of view.repoNavSections) {
          expect(row.badgeColor).toBeTruthy()
          expect(row.repoIcon).toBeTruthy()
          expect(row.upstream).toBeTruthy()
          expect(row.isRemote).toBe(true)
        }
        if (pass === 'cold' && experiment.r === 100) {
          const html = renderToStaticMarkup(
            <TooltipProvider>
              <SettingsSidebar
                activeSectionId="general"
                settings={null}
                generalGroups={view.generalNavGroups}
                repoSections={view.repoNavSections}
                hasRepos
                onBack={() => {}}
                onSelectSection={() => {}}
              />
            </TooltipProvider>
          )
          expect(html).toContain('icon-0')
          expect(html).toContain('Fork of upstream/repo-0')
          expect(html).toContain('SSH')
        }
        const counterNames = [
          'catalogVisits',
          'lookupPreparations',
          'lookupQueries',
          'sectionProjections',
          'builderRawComparisons',
          'builderIdReads'
        ] as const
        const delta = Object.fromEntries(
          counterNames.map((key) => [key, counters[key] - before[key]])
        )
        expect(delta.lookupQueries).toBe(experiment.s)
        expect(delta.sectionProjections).toBe(experiment.s)
        expect(delta.builderRawComparisons).toBe(0)
        expect(delta.builderIdReads).toBeGreaterThanOrEqual(view.repoNavSections.length)
        expect(delta.catalogVisits).toBe(
          pass === 'cold' || pass === 'replacement' ? experiment.r : 0
        )
        process.stdout.write(
          `PG9 metadata operations ${JSON.stringify({ ...experiment, pass, query, ...delta, outputs: view.repoNavSections.length })}\n`
        )
      }
      run(repos, '', 'cold')
      run(repos, '', 'warm')
      run(repos, 'Settings 0', 'search')
      run(
        observe(
          observed.map((repo, i) =>
            i === 0
              ? {
                  ...repo,
                  get badgeColor() {
                    if (phase === 'nav') {
                      counters.sectionProjections++
                    }
                    return 'replacement-color'
                  }
                }
              : repo
          )
        ),
        '',
        'replacement'
      )
    } finally {
      lookupSpy.mockRestore()
      for (const restore of querySpies) {
        restore()
      }
    }
  }
})
