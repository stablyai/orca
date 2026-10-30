// @vitest-environment happy-dom
import { createRoot } from 'react-dom/client'
import { act, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { render, cleanup, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { TooltipProvider } from '../ui/tooltip'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo,
  removeSettingsProjectFromAllHosts
} from './settings-project-list'
import {
  buildSettingsViewModel,
  useConcreteProjectContinuity,
  useSettingsNavigationActions
} from './settings-view-model'
import { renderSettingsPage } from './settings-page-renderer'
import { LOCAL_SETTINGS_HOST_SCOPE } from './settings-host-scope'
import type { SettingsStoreModel } from './use-settings-store-model'
import {
  useSettingsInteractionController,
  type SettingsInteractionController
} from './use-settings-interaction-controller'
import type { SettingsRenderContext } from './settings-render-context'
import { useSettingsPageEffects } from './use-settings-page-effects'
import { useSettingsRepoScrollEffects } from './use-settings-repo-scroll-effects'
import { useSettingsNavigationModel } from './use-settings-navigation-model'
import type { SettingsTerminalModel } from './use-settings-terminal-model'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('keeps the actual implicit and explicitly chosen checkout through control saves, external regroup and rollback without a blank commit', async () => {
  const first: Repo = {
    id: 'a',
    path: '/work/harbor-first',
    displayName: 'Harbor',
    badgeColor: '',
    addedAt: 0,
    upstream: null,
    sourceControlAi: {
      actionOverrides: {
        commitMessage: { agentId: 'codex', commandInputTemplate: 'initial', agentArgs: '' }
      }
    },
    gitRemoteIdentity: {
      canonicalKey: 'github.com/org/harbor',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/org/harbor'
    }
  }
  const second = { ...first, id: 'b', path: '/work/harbor-second' }
  const twin = {
    ...first,
    path: '/ssh/harbor',
    connectionId: 'box',
    executionHostId: 'ssh:box' as const
  }
  const repos = [first, second, twin]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const projectId = projection.projects[0].id
  let saved = getDefaultSettings('/tmp')
  const persist = vi.fn(async (patch: object) => {
    saved = { ...saved, ...patch }
    return saved
  })
  const writeRepo = vi.fn(
    async (_args: {
      repoId: string
      hostId?: string
      updates: Partial<Repo>
    }): Promise<Repo | undefined> => undefined
  )
  const removeForHost = vi.fn(async (_args: { repoId: string; hostId: string }) => {})
  const readIssue = vi.fn(async () => ({
    status: 'ok',
    localContent: 'initial issue',
    sharedContent: null
  }))
  const writeIssue = vi.fn(async () => {})
  const savePreset = vi.fn(
    async (args: { repoId: string; name: string; directories: string[] }) => ({
      ...args,
      id: 'saved-preset',
      createdAt: 1,
      updatedAt: 1
    })
  )
  Object.assign(window, {
    api: {
      settings: { set: persist },
      platform: { get: () => ({ platform: 'darwin' }) },
      updater: { getVersion: async () => '0.0.0' },
      gh: { checkOrcaStarred: async () => false },
      runtimeEnvironments: { list: async () => [] },
      pty: { management: { listSessions: async () => ({ sessions: [] }) } },
      hooks: { readIssueCommand: readIssue, writeIssueCommand: writeIssue },
      repos: {
        update: writeRepo,
        removeForHost,
        getBaseRefDefault: async () => ({ defaultBaseRef: 'main', remoteCount: 1 })
      },
      sparsePresets: { save: savePreset },
      preflight: { detectAgents: async () => [], detectRemoteAgents: async () => [] },
      fs: { readDir: async () => [] }
    }
  })
  useAppStore.setState({
    activeView: 'settings',
    repos: [second, twin],
    settings: saved,
    sparsePresetsByRepo: { a: [], b: [] },
    sparsePresetsLoadStatusByRepo: { a: 'loaded', b: 'loaded' },
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  const commits: string[] = []
  let navigate!: ReturnType<typeof useSettingsNavigationActions>['scrollToSection']
  let discardAllowed = true
  const nothing = () => {}
  const asyncNothing = async () => {}
  let selectedSection = ''
  let activeNeeded = false
  let visibleCount = 0
  let selectSecond!: () => void
  let selectTwin!: () => void
  let markGlobalDirty!: () => void
  function Harness() {
    const state = useAppStore(
      useShallow((state) => ({
        repos: state.repos,
        settings: state.settings,
        projects: state.projects,
        projectHostSetups: state.projectHostSetups,
        settingsProjectHostSelection: state.settingsProjectHostSelection,
        settingsProjectSetupSelection: state.settingsProjectSetupSelection,
        setSettingsProjectHostSelection: state.setSettingsProjectHostSelection,
        settingsSearchQuery: state.settingsSearchQuery,
        setSettingsSearchQuery: state.setSettingsSearchQuery,
        settingsNavigationTarget: state.settingsNavigationTarget,
        clearSettingsTarget: state.clearSettingsTarget,
        updateRepo: state.updateRepo,
        updateProject: state.updateProject
      }))
    )
    const grouping = useAppStore(getProjectGroupingModelFromState)
    const entries = useMemo(
      () => buildSettingsProjectList(state.repos, grouping),
      [state.repos, grouping]
    )
    const [activeSectionId, setActiveSectionId] = useState(`repo-${entries[0].selectionKey}`)
    const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
    const [mountedSectionIds, setMountedSectionIds] = useState(new Set<string>())
    const [repoHooksMap, setRepoHooksMap] = useState({})
    const [hasUnsavedCommitPromptChanges, setHasUnsavedCommitPromptChanges] = useState(false)
    markGlobalDirty = () => setHasUnsavedCommitPromptChanges(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all fields read by continuity/actions/renderer are supplied.
    const raw = {
      ...state,
      settingsProjectList: entries,
      activeSectionId,
      setActiveSectionId,
      pendingNavRequestTick,
      setPendingNavRequestTick,
      setMountedSectionIds,
      mountedSectionIds,
      repoHooksMap,
      setRepoHooksMap,
      repoIdToRepresentative: buildRepoIdToRepresentative(entries),
      repoIdToHostSelection: buildRepoIdToHostSelection(entries),
      fetchSettings: asyncNothing,
      fetchKeybindings: asyncNothing,
      refreshModelStates: asyncNothing,
      setVoiceModelStatesLoading: nothing,
      setHighlightedSettingsTargetId: nothing,
      showDesktopOnlySettings: false,
      isWebClient: true,
      settingsHostScope: LOCAL_SETTINGS_HOST_SCOPE,
      runtimeEnvironments: [],
      terminalFontSuggestions: [],
      fontSuggestions: [],
      removeProjectAllHosts: (setups: Parameters<typeof removeSettingsProjectFromAllHosts>[0]) =>
        removeSettingsProjectFromAllHosts(setups, useAppStore.getState().removeProject),
      prevScrollbackRows: state.settings?.terminalScrollbackRows,
      setPrevScrollbackRows: nothing,
      setScrollbackMode: nothing,
      orchestrationSkill: { installed: false, loading: false },
      linearSkill: { installed: false, loading: false, skills: [] },
      computerUseSkill: { installed: false, loading: false },
      linearConnected: false,
      closeSettingsPage: useAppStore.getState().closeSettingsPage,
      confirm: async () => discardAllowed,
      setFontSuggestions: nothing,
      setSourceControlAiPromptDiscardSignal: nothing,
      setHasUnsavedCommitPromptChanges,
      setHasUnsavedBranchPromptChanges: nothing,
      setHasUnsavedChatPromptChanges: nothing,
      hasUnsavedCommitPromptChanges,
      hasUnsavedBranchPromptChanges: false,
      hasUnsavedChatPromptChanges: false
    } as unknown as SettingsStoreModel
    const interactions = useSettingsInteractionController(raw)
    const navigation = useSettingsNavigationModel(raw, interactions)
    const model = navigation.model
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hook-file loading is outside the presentation fixture.
    const terminal = { neededRepos: [] } as unknown as SettingsTerminalModel
    useSettingsPageEffects(model, interactions)
    useSettingsRepoScrollEffects(model, interactions, navigation, terminal)
    selectedSection = model.activeSectionId
    activeNeeded = navigation.neededSectionIds.has(model.activeSectionId)
    visibleCount = navigation.visibleNavSections.length
    const actions = useSettingsNavigationActions(model, interactions)
    navigate = actions.scrollToSection
    selectSecond = () => {
      const entry = entries.find((entry) =>
        entry.setups.some((setup) => setup.repoId === second.id)
      )!
      const setup = entry.setups.find((setup) => setup.repoId === second.id)!
      state.setSettingsProjectHostSelection(entry.selectionKey, setup.hostId, setup.id)
      setActiveSectionId(`repo-${entry.selectionKey}`)
    }
    selectTwin = () => {
      const entry = entries.find((entry) =>
        entry.setups.some((setup) => setup.hostId === 'ssh:box')
      )!
      const setup = entry.setups.find((setup) => setup.hostId === 'ssh:box')!
      state.setSettingsProjectHostSelection(entry.selectionKey, setup.hostId, setup.id)
      setActiveSectionId(`repo-${entry.selectionKey}`)
    }
    const active = entries.find((entry) => `repo-${entry.selectionKey}` === model.activeSectionId)
    const selected =
      active &&
      getSettingsEntryHostSelection(
        active,
        model.settingsProjectHostSelection,
        model.settingsProjectSetupSelection
      )
    const path =
      active &&
      selected &&
      getSettingsProjectHostRepo(active, state.repos, selected.hostId, selected.setupId)?.path
    useLayoutEffect(() => {
      commits.push(path ?? model.activeSectionId)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: renderer reads only these presentation/navigation/terminal fields.
    const context = {
      model,
      interactions,
      actions,
      navigation,
      terminal: {
        windowsTerminalCapabilities: {},
        localWindowsRuntimeCapabilities: {},
        isWindowsTerminalHost: false
      },
      view: buildSettingsViewModel(model, navigation)
    } as unknown as SettingsRenderContext
    return renderSettingsPage(context)
  }
  function SettingsPageRoot() {
    const activeView = useAppStore((state) => state.activeView)
    return activeView === 'settings' ? <Harness /> : null
  }
  // App's outer tooltip context is outside the actual shipping page, which supplies its own providers.
  render(
    <TooltipProvider>
      <SettingsPageRoot />
    </TooltipProvider>
  )
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  expect(writeRepo).not.toHaveBeenCalled()
  act(() => useAppStore.setState({ repos }))
  const user = userEvent.setup()
  async function choose(label: string | RegExp) {
    await user.click(screen.getByRole('combobox', { name: 'Group checkouts' }))
    await user.click(screen.getByRole('option', { name: label }))
  }
  expect(screen.getByText(first.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  const recipe = () => document.getElementById('repo-a-source-control-ai-commitMessage')!
  const template = () => recipe().querySelector<HTMLTextAreaElement>('textarea')!
  const args = () => recipe().querySelector<HTMLInputElement>('input')!
  const location = () => screen.getByPlaceholderText<HTMLInputElement>(saved.workspaceDir)
  await user.clear(template())
  await user.type(template(), 'unsaved command')
  await user.type(args(), '--unsaved-args')
  await user.click(screen.getByRole('button', { name: 'New Preset' }))
  await user.type(screen.getByRole('textbox', { name: 'Name', exact: true }), 'unsaved preset')
  await user.click(screen.getByRole('combobox', { name: 'Add a folder' }))
  await user.type(screen.getByPlaceholderText('Find a folder, or type any path…'), 'src')
  await user.keyboard('{Enter}')
  await user.type(screen.getByPlaceholderText('example.com'), 'https://harbor.example')
  const custom = screen.getByPlaceholderText('e.g. ollama run llama3.1 {prompt}')
  await user.click(within(custom.parentElement!).getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: 'Repository command' }))
  commits.length = 0
  await choose('Separate by folder')
  expect(template().value).toBe('unsaved command')
  expect(args().value).toBe('--unsaved-args')
  expect(screen.getByRole('textbox', { name: 'Name', exact: true })).toHaveProperty(
    'value',
    'unsaved preset'
  )
  expect(screen.getByPlaceholderText('example.com')).toHaveProperty(
    'value',
    'https://harbor.example'
  )
  expect(writeRepo.mock.calls.filter(([args]) => args.updates.sourceControlAi)).toHaveLength(0)
  expect(savePreset).not.toHaveBeenCalled()
  expect(persist).toHaveBeenCalled()
  expect(new Set(commits)).toEqual(new Set([first.path]))
  act(() =>
    useAppStore.setState({
      repos: [first, twin],
      settings: { ...saved, projectGroupingOverrides: {} }
    })
  )
  act(() => useAppStore.getState().setSettingsSearchQuery('sparse checkout presets'))
  await waitFor(() =>
    expect(document.getElementById('repo-a-source-control-ai-commitMessage')).toBeNull()
  )
  expect(screen.getByRole('textbox', { name: 'Name', exact: true })).toHaveProperty(
    'value',
    'unsaved preset'
  )
  // Keep the actual setting-title query through a source-only gap: neither search nor navigation changed.
  const beforeGapSection = selectedSection
  const explicitWritesBeforeGap = writeRepo.mock.calls.filter(
    ([args]) => args.updates.sourceControlAi
  ).length
  act(() => useAppStore.setState({ repos: [twin] }))
  expect(useAppStore.getState().settingsSearchQuery).toBe('sparse checkout presets')
  expect(selectedSection).toBe(beforeGapSection)
  expect(activeNeeded).toBe(false)
  expect(visibleCount).toBe(0)
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  expect(screen.getByText('No settings found for "sparse checkout presets"')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save preset' })).toBeNull()
  expect(document.getElementById('repo-a-source-control-ai-commitMessage')).toBeNull()
  const unavailableDuringGap = screen.queryByText('Available Hosts') !== null
  act(() => useAppStore.setState({ repos: [first, twin] }))
  expect(screen.getByRole('textbox', { name: 'Name', exact: true })).toHaveProperty(
    'value',
    'unsaved preset'
  )
  expect(screen.getByText('src', { exact: true })).toBeTruthy()
  expect(unavailableDuringGap).toBe(true)
  expect(savePreset).not.toHaveBeenCalled()
  expect(writeRepo.mock.calls.filter(([args]) => args.updates.sourceControlAi)).toHaveLength(
    explicitWritesBeforeGap
  )
  // A no-match query with the exact source present is presentation only until a fallback commits.
  act(() => useAppStore.getState().setSettingsSearchQuery('no-match-pg9-current-session'))
  await waitFor(() => expect(visibleCount).toBe(0))
  expect(selectedSection).toBe(beforeGapSection)
  expect(screen.getByText('No settings found for "no-match-pg9-current-session"')).toBeTruthy()
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  act(() => useAppStore.getState().setSettingsSearchQuery('sparse checkout presets'))
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Name', exact: true })).toBeTruthy()
  )
  expect(screen.getByRole('textbox', { name: 'Name', exact: true })).toHaveProperty(
    'value',
    'unsaved preset'
  )
  expect(screen.getByText('src', { exact: true })).toBeTruthy()
  expect(savePreset).not.toHaveBeenCalled()
  expect(writeRepo.mock.calls.filter(([args]) => args.updates.sourceControlAi)).toHaveLength(
    explicitWritesBeforeGap
  )
  act(() => useAppStore.getState().setSettingsSearchQuery(''))
  expect(template().value).toBe('unsaved command')
  expect(args().value).toBe('--unsaved-args')
  act(() => useAppStore.setState({ repos }))
  // Publication has no natural blur. Location and composing display name retain their real controllers.
  await user.type(location(), '../pending-location')
  const writesBefore = writeRepo.mock.calls.length
  act(() => useAppStore.setState({ settings: { ...saved, projectGroupingOverrides: {} } }))
  expect(location().value).toBe('../pending-location')
  expect(writeRepo).toHaveBeenCalledTimes(writesBefore)
  await user.click(screen.getByText('Identity', { selector: 'h3' }))
  await waitFor(() =>
    expect(
      writeRepo.mock.calls.some(([args]) => args.updates.worktreeBasePath === '../pending-location')
    ).toBe(true)
  )
  const name = screen.getByRole('textbox', { name: 'Display Name' })
  fireEvent.compositionStart(name)
  fireEvent.change(name, { target: { value: '未確定' } })
  const beforeComposition = writeRepo.mock.calls.length
  act(() =>
    useAppStore.setState({
      settings: { ...saved, projectGroupingOverrides: { [projectId]: 'folder' } }
    })
  )
  expect(screen.getByRole('textbox', { name: 'Display Name' })).toHaveProperty('value', '未確定')
  expect(writeRepo).toHaveBeenCalledTimes(beforeComposition)
  fireEvent.compositionEnd(screen.getByRole('textbox', { name: 'Display Name' }))
  await waitFor(() =>
    expect(writeRepo.mock.calls.some(([args]) => args.updates.displayName === '未確定')).toBe(true)
  )
  // Exact Repo absence suspends a dirty script timer while the single issue watcher and all pending inputs survive.
  vi.useFakeTimers()
  fireEvent.change(screen.getByRole('textbox', { name: 'Setup Script' }), {
    target: { value: 'echo pending setup' }
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'Custom GitHub Issue Command' }), {
    target: { value: 'pending issue' }
  })
  const issueReads = readIssue.mock.calls.length
  const scriptWrites = () =>
    writeRepo.mock.calls.filter(([args]) => args.updates.hookSettings).length
  const scriptBefore = scriptWrites()
  act(() => useAppStore.setState({ repos: [second, twin] }))
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  expect(screen.queryByText('Source Control AI', { selector: 'h3' })).toBeNull()
  act(() => vi.advanceTimersByTime(1000))
  expect(scriptWrites()).toBe(scriptBefore)
  act(() =>
    useAppStore.setState({
      repos: [
        useAppStore.getState().repos.find((repo) => repo.id === 'b')!,
        { ...first, displayName: '未確定', worktreeBasePath: '../pending-location' },
        twin
      ]
    })
  )
  expect(template().value).toBe('unsaved command')
  expect(args().value).toBe('--unsaved-args')
  expect(screen.getByRole('textbox', { name: 'Name', exact: true })).toHaveProperty(
    'value',
    'unsaved preset'
  )
  expect(screen.getByRole('textbox', { name: 'Custom GitHub Issue Command' })).toHaveProperty(
    'value',
    'pending issue'
  )
  expect(readIssue).toHaveBeenCalledTimes(issueReads)
  expect(
    within(
      screen.getByPlaceholderText('e.g. ollama run llama3.1 {prompt}').parentElement!
    ).getByRole('combobox').textContent
  ).toContain('Repository command')
  await act(async () => {
    vi.advanceTimersByTime(700)
  })
  expect(scriptWrites()).toBe(scriptBefore + 1)
  vi.useRealTimers()
  fireEvent.blur(screen.getByRole('textbox', { name: 'Custom GitHub Issue Command' }))
  await waitFor(() =>
    expect(writeIssue).toHaveBeenCalledWith({
      repoId: 'a',
      hostId: 'local',
      content: 'pending issue',
      wakeWslDistro: true
    })
  )
  await user.click(screen.getByRole('button', { name: 'Favicon' }))
  await waitFor(() =>
    expect(
      writeRepo.mock.calls.some(
        ([args]) =>
          args.hostId === 'local' &&
          args.updates.repoIcon?.type === 'image' &&
          args.updates.repoIcon.source === 'favicon'
      )
    ).toBe(true)
  )
  await user.click(screen.getByRole('button', { name: 'Add Path' }))
  await user.type(
    screen.getByPlaceholderText('Type a path (e.g. .env or node_modules)…'),
    '.pending-env'
  )
  act(() => useAppStore.setState({ settings: { ...saved, projectGroupingOverrides: {} } }))
  expect(screen.getByPlaceholderText('Type a path (e.g. .env or node_modules)…')).toHaveProperty(
    'value',
    '.pending-env'
  )
  await user.click(screen.getByRole('option', { name: 'Add .pending-env' }))
  await waitFor(() =>
    expect(
      writeRepo.mock.calls.some(([args]) => args.updates.symlinkPaths?.includes('.pending-env'))
    ).toBe(true)
  )
  await user.click(screen.getByRole('button', { name: 'Save preset' }))
  expect(savePreset).toHaveBeenCalledWith(
    expect.objectContaining({ repoId: 'a', name: 'unsaved preset', directories: ['src'] })
  )
  // Failed explicit Save retains both fields; a successful captured Save cannot clear newer typing.
  writeRepo.mockRejectedValueOnce(new Error('save refused'))
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  await user.click(within(recipe()).getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(screen.getByText('Failed to save Source Control AI settings.')).toBeTruthy()
  )
  quiet.mockRestore()
  expect(template().value).toBe('unsaved command')
  let finishWrite!: () => void
  writeRepo.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    return undefined
  })
  await user.click(within(recipe()).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(finishWrite).toBeTypeOf('function'))
  await user.type(template(), ' newer')
  act(() =>
    useAppStore.setState({
      settings: { ...saved, projectGroupingOverrides: { [projectId]: 'folder' } }
    })
  )
  await act(async () => finishWrite())
  expect(template().value).toBe('unsaved command newer')
  expect(within(recipe()).getByText('Unsaved changes')).toBeTruthy()
  // Same raw id on another host is a new session. An old completion stays with its accepted target.
  let finishOld!: () => void
  writeRepo.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finishOld = resolve
    })
    return undefined
  })
  await user.click(within(recipe()).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(finishOld).toBeTypeOf('function'))
  act(() => selectTwin())
  expect(screen.getByText(twin.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  expect(template().value).toBe('initial')
  await user.clear(template())
  await user.type(template(), 'successor draft')
  await act(async () => finishOld())
  expect(template().value).toBe('successor draft')
  expect(writeRepo.mock.calls.at(-1)![0].hostId).toBe('local')
  act(() => selectSecond())
  commits.length = 0
  await choose(/Use default/)
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  expect(new Set(commits)).toEqual(new Set([second.path]))
  // Published input changes use the same projection, including a surviving merged key that loses this member.
  commits.length = 0
  act(() =>
    useAppStore.setState({
      settings: { ...saved, projectGroupingOverrides: { [projectId]: 'folder' } }
    })
  )
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  act(() => useAppStore.setState({ settings: saved }))
  expect(new Set(commits)).toEqual(new Set([second.path]))
  act(() => useAppStore.setState({ repos: [first] }))
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  act(() => useAppStore.setState({ repos }))
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  const movedProjects = [
    ...projection.projects,
    { ...projection.projects[0], id: 'moved', displayName: 'Moved Harbor' }
  ]
  const movedSetups = projection.setups.map((setup) =>
    setup.repoId === second.id ? { ...setup, projectId: 'moved' } : setup
  )
  commits.length = 0
  act(() => useAppStore.setState({ projects: movedProjects, projectHostSetups: movedSetups }))
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  expect(new Set(commits)).toEqual(new Set([second.path]))
  act(() =>
    useAppStore.setState({ projects: projection.projects, projectHostSetups: projection.setups })
  )
  persist.mockRejectedValueOnce(new Error('write refused'))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await choose('Separate by folder')
  error.mockRestore()
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  act(() => markGlobalDirty())
  discardAllowed = false
  await act(async () => {
    await navigate('general')
  })
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  discardAllowed = true
  act(() => useAppStore.getState().setSettingsSearchQuery('terminal scrollback'))
  await waitFor(() =>
    expect(useAppStore.getState().settingsSearchQuery).toBe('terminal scrollback')
  )
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  act(() => useAppStore.getState().setSettingsSearchQuery(''))
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
  // The real deep-link and scroll owners replace the abandoned anchor with the requested checkout.
  act(() =>
    useAppStore.getState().openSettingsTarget({ pane: 'repo', repoId: first.id, hostId: 'local' })
  )
  expect(screen.getByText(first.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  expect(useAppStore.getState().settingsNavigationTarget).toBeNull()
  act(() => selectSecond())
  expect(screen.getByText(second.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  act(() =>
    useAppStore.setState({
      projectHostSetups: projection.setups.filter(
        (setup) => setup.repoId === first.id && setup.hostId === 'local'
      ),
      repos: [first]
    })
  )
  expect(screen.getByText(first.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  act(() => useAppStore.setState({ projectHostSetups: projection.setups, repos }))
  expect(screen.getByText(first.path, { selector: 'p.max-w-3xl' })).toBeTruthy()
  expect(selectedSection).toMatch(/^repo-/)
  // Declining the real remove button and a refused host call retain the session; accepted removal retires it.
  await choose('Separate by folder')
  await user.clear(template())
  await user.type(template(), 'retire only on committed removal')
  await user.click(screen.getByRole('button', { name: 'Remove Project', exact: true }))
  await user.click(screen.getByText('Identity', { selector: 'h3' }))
  expect(removeForHost).not.toHaveBeenCalled()
  expect(template().value).toBe('retire only on committed removal')
  removeForHost.mockRejectedValueOnce(new Error('host refused removal'))
  const quietRemoval = vi.spyOn(console, 'error').mockImplementation(() => {})
  await user.click(screen.getByRole('button', { name: 'Remove Project', exact: true }))
  await user.click(screen.getByRole('button', { name: 'Confirm Remove Project', exact: true }))
  await waitFor(() => expect(removeForHost).toHaveBeenCalledTimes(1))
  quietRemoval.mockRestore()
  expect(template().value).toBe('retire only on committed removal')
  await user.click(screen.getByRole('button', { name: 'Remove Project', exact: true }))
  await user.click(screen.getByRole('button', { name: 'Confirm Remove Project', exact: true }))
  await waitFor(() =>
    expect(
      useAppStore
        .getState()
        .projectHostSetups.some((setup) => setup.repoId === 'a' && setup.hostId === 'local')
    ).toBe(false)
  )
  expect(screen.queryByText(first.path, { selector: 'p.max-w-3xl' })).toBeNull()
  act(() =>
    useAppStore.setState({
      projectHostSetups: projection.setups,
      projects: projection.projects,
      repos
    })
  )
  expect(screen.queryByText(first.path, { selector: 'p.max-w-3xl' })).toBeNull()
  act(() =>
    useAppStore.getState().openSettingsTarget({ pane: 'repo', repoId: first.id, hostId: 'local' })
  )
  expect(template().value).not.toBe('retire only on committed removal')
  expect(screen.queryByRole('textbox', { name: 'Name', exact: true })).toBeNull()
  await user.clear(template())
  await user.type(template(), 'retire on Settings close')
  act(() => markGlobalDirty())
  discardAllowed = false
  await user.click(screen.getByRole('button', { name: 'Back to app' }))
  expect(useAppStore.getState().activeView).toBe('settings')
  expect(template().value).toBe('retire on Settings close')
  discardAllowed = true
  await user.click(screen.getByRole('button', { name: 'Back to app' }))
  expect(useAppStore.getState().activeView).not.toBe('settings')
  expect(document.querySelector('.settings-view-shell')).toBeNull()
  act(() => useAppStore.setState({ repos }))
  expect(document.querySelector('.settings-view-shell')).toBeNull()
  act(() => useAppStore.setState({ activeView: 'settings' }))
  expect(template().value).not.toBe('retire on Settings close')
  await act(async () => {
    await navigate('general')
  })
  act(() =>
    useAppStore.setState({
      settings: { ...saved, projectGroupingOverrides: { [projectId]: 'folder' } }
    })
  )
  expect(document.querySelector('input[id^="repo-display-name-"]')).toBeNull()
})

it('bounds the mounted current-selection regroup operation with independent entry and setup populations', () => {
  for (const dimension of ['entries', 'setups'] as const) {
    for (const n of [100, 1000]) {
      const repos = Array.from({ length: 1000 }, (_, i) => ({
        id: `settings-${i}`,
        path: `/settings/${i}`,
        displayName: `Settings ${i}`,
        badgeColor: '',
        addedAt: 0
      }))
      const projection = projectHostSetupProjectionFromRepos(repos)
      const count = dimension === 'entries' ? n : 1000
      const setupCount = dimension === 'setups' ? n : 1000
      const setups = projection.setups
        .slice(0, setupCount)
        .map((setup, i) => ({ ...setup, projectId: projection.projects[i % count].id }))
      let entries = buildSettingsProjectList(repos, {
        projects: projection.projects.slice(0, count),
        projectHostSetups: setups
      })
      let activeSectionId = `repo-${entries[0].selectionKey}`
      const hosts = {}
      const choices = {}
      const setActiveSectionId = (id: string) => {
        activeSectionId = id
      }
      const nothing = () => {}
      const container = document.createElement('div')
      const root = createRoot(container)
      let actual = ''
      function Harness() {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exact fields read by continuity are supplied.
        const input = {
          settingsProjectList: entries,
          activeSectionId,
          setActiveSectionId,
          settingsProjectHostSelection: hosts,
          settingsProjectSetupSelection: choices,
          setSettingsProjectHostSelection: nothing,
          settingsNavigationTarget: null
        } as unknown as SettingsStoreModel
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: continuity reads only the pending navigation ref.
        const interactions = {
          pendingNavSectionRef: useRef(null)
        } as unknown as SettingsInteractionController
        actual = useConcreteProjectContinuity(input, interactions).activeSectionId
        return null
      }
      const get = Map.prototype.get
      let reads = 0
      try {
        act(() => root.render(<Harness />))
        const probe = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown
        ) {
          reads++
          return get.call(this, key)
        })
        try {
          entries = buildSettingsProjectList(repos, {
            projects: projection.projects.slice(0, count),
            projectHostSetups: setups,
            settings: { projectGroupingMode: 'folder' }
          })
          act(() => root.render(<Harness />))
          expect(actual).toBe(
            `repo-${entries.find((entry) => entry.setups.some((setup) => setup.repoId === repos[0].id))!.selectionKey}`
          )
          expect(reads).toBeGreaterThan(setupCount)
          expect(reads).toBeLessThan(60 * (count + setupCount))
          process.stdout.write(
            `PG8 settings operations ${JSON.stringify({ dimension, n, entries: entries.length, setups: setupCount, reads })}\n`
          )
        } finally {
          probe.mockRestore()
        }
      } finally {
        act(() => root.unmount())
      }
    }
  }
})
