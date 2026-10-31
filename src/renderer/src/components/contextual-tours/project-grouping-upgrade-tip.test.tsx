import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { GeneralWorkspaceSettingsSection } from '../settings/GeneralWorkspaceSettingsSection'
import { useSettingsPageEffects } from '../settings/use-settings-page-effects'
import { useSettingsRepoScrollEffects } from '../settings/use-settings-repo-scroll-effects'
import type { SettingsStoreModel } from '../settings/use-settings-store-model'
import type { SettingsInteractionController } from '../settings/use-settings-interaction-controller'
import type { SettingsNavigationModel } from '../settings/use-settings-navigation-model'
import type { SettingsTerminalModel } from '../settings/use-settings-terminal-model'
import { useProjectGroupingUpgradeTip } from './use-project-grouping-upgrade-tip'
import { getLocalizedContextualTourStepCopy } from './contextual-tour-step-copy'

const audience = {
  version: 1 as const,
  membership: 'eligible' as const,
  projectId: 'github:org/app',
  hostId: 'local',
  checkoutCount: 2
}
function Tip() {
  useProjectGroupingUpgradeTip()
  const view = useAppStore((s) => s.activeView)
  return (
    <>
      <ContextualTourOverlay />
      {view === 'settings' ? <SettingsDestination /> : null}
    </>
  )
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.assign(window, {
    api: { ui: { set: vi.fn(async () => {}), recordFeatureInteraction: vi.fn(async () => ({})) } }
  })
  const repos = ['a', 'b'].map((id) => ({
    id,
    path: `/${id}`,
    displayName: 'App',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }))
  const projection = projectHostSetupProjectionFromRepos(repos)
  useAppStore.setState({
    repos,
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: getDefaultSettings(''),
    projectGroupingSettingsHydrated: true,
    projectGroupingUpgradeTipAudience: audience,
    persistedUIReady: true,
    contextualToursAutoEligible: false,
    activeModal: 'none'
  })
  const header = document.createElement('div')
  header.dataset.projectGroupingKey = 'project:github:org/app'
  header.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 200, height: 30 })
  document.body.appendChild(header)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.querySelectorAll('[data-project-grouping-key]').forEach((element) => element.remove())
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each(['Got it', 'Dismiss tour', 'Group checkouts in Settings'])(
  'dismisses the actual upgrade overlay permanently through %s',
  async (action) => {
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return DOMRect.fromRect({ y: this.id === 'general-projects' ? 320 : 10, height: 100 })
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    const user = userEvent.setup()
    const view = render(<Tip />)
    expect(await screen.findByText('App is now one project')).toBeTruthy()
    expect(screen.getByText(/Your 2 checkouts of App/)).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: action }))
    expect(useAppStore.getState().contextualToursSeenIds).toContain('project-grouping-upgrade')
    expect(screen.queryByText('App is now one project')).toBeNull()
    if (action === 'Group checkouts in Settings') {
      expect(useAppStore.getState().settingsNavigationTarget).toBeNull()
      expect(useAppStore.getState().activeView).toBe('settings')
      await waitFor(() =>
        expect(document.getElementById('general-projects')?.dataset.highlighted).toBe('true')
      )
      const target = document.getElementById('general-projects')!
      expect(target.querySelector('[aria-label="Group checkouts"]')).toBeTruthy()
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 294 }))
    }
    const seen = useAppStore.getState().contextualToursSeenIds
    view.unmount()
    // A fresh renderer uses the durable seen list supplied at startup, not a view-time timer.
    act(() =>
      useAppStore.setState({
        activeContextualTourId: null,
        contextualTourShownThisSession: false,
        contextualToursSeenIds: [...seen]
      })
    )
    vi.useFakeTimers()
    render(<Tip />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.queryByText('App is now one project')).toBeNull()
  }
)

it('consumes the audience when a separate mode is chosen before first display', async () => {
  useAppStore.setState({ settings: { ...getDefaultSettings(''), projectGroupingMode: 'host' } })
  render(<Tip />)
  await act(async () => {})
  expect(useAppStore.getState().contextualToursSeenIds).toContain('project-grouping-upgrade')
  act(() => useAppStore.setState({ settings: getDefaultSettings('') }))
  await act(async () => {})
  expect(screen.queryByText('App is now one project')).toBeNull()
})

vi.mock('../settings/WorkspaceDirectorySetting', () => ({ WorkspaceDirectorySetting: () => null }))
vi.mock('../settings/OpenInMenuSetting', () => ({ OpenInMenuSetting: () => null }))
const noChange = () => {}
const loaded = async () => {}
function SettingsDestination() {
  const state = useAppStore(
    useShallow((state) => ({
      settings: state.settings,
      updateSettings: state.updateSettings,
      keybindings: state.keybindings,
      clearSettingsTarget: state.clearSettingsTarget,
      settingsNavigationTarget: state.settingsNavigationTarget,
      setSettingsProjectHostSelection: state.setSettingsProjectHostSelection,
      repos: state.repos,
      setSettingsSearchQuery: state.setSettingsSearchQuery,
      settingsSearchQuery: state.settingsSearchQuery
    }))
  )
  const [activeSectionId, setActiveSectionId] = useState('appearance')
  const [mountedSectionIds, setMountedSectionIds] = useState(new Set<string>())
  const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
  const [highlightedSettingsTargetId, setHighlightedSettingsTargetId] = useState<string | null>(
    null
  )
  const pendingNavSectionRef = useRef<string | null>(null)
  const pendingScrollTargetRef = useRef<string | null>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const interactions = {
    pendingNavSectionRef,
    pendingScrollTargetRef,
    contentScrollRef,
    pendingScrollTargetWatchRef: useRef(null),
    pendingSubsectionScrollFrameRef: useRef<number | null>(null),
    repoHooksRequestSeqRef: useRef(0),
    searchInputRef: useRef<HTMLInputElement | null>(null),
    shortcutsEscapeConfirmUntilRef: useRef(0),
    hasUnsavedSourceControlAiPromptChangesRef: useRef(false),
    closeSettingsPageWithPromptGuard: loaded,
    promptDiscardSourceControlAiPromptChanges: loaded
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: uses real store navigation/clear actions with all local page/scroll fields supplied.
  const model = {
    ...state,
    activeSectionId,
    setActiveSectionId,
    mountedSectionIds,
    setMountedSectionIds,
    pendingNavRequestTick,
    setPendingNavRequestTick,
    highlightedSettingsTargetId,
    setHighlightedSettingsTargetId,
    fetchSettings: loaded,
    fetchKeybindings: loaded,
    refreshModelStates: loaded,
    showDesktopOnlySettings: false,
    setVoiceModelStatesLoading: noChange,
    settingsProjectList: [],
    repoIdToHostSelection: new Map(),
    repoIdToRepresentative: new Map(),
    setRepoHooksMap: noChange,
    setSettingsHostChoice: noChange,
    setQuickCommandAddIntentSignal: noChange,
    setRemoteServerAddIntentSignal: noChange,
    setSshHostAddIntentSignal: noChange
  } as unknown as SettingsStoreModel
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the exact interaction refs read by both production navigation effects.
  const controller = interactions as unknown as SettingsInteractionController
  useSettingsPageEffects(model, controller)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scroll effects read only these visible navigation IDs and sections.
  const navigation = {
    visibleNavSections: [{ id: 'appearance' }, { id: 'general' }],
    visibleSectionIds: new Set(['appearance', 'general'])
  } as unknown as SettingsNavigationModel
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no project hook reads are needed for General.
  const terminal = { neededRepos: [] } as unknown as SettingsTerminalModel
  useSettingsRepoScrollEffects(model, controller, navigation, terminal)
  return (
    <div ref={contentScrollRef}>
      {activeSectionId === 'general' && mountedSectionIds.has('general') ? (
        <section id="general">
          <GeneralWorkspaceSettingsSection
            settings={state.settings!}
            updateSettings={state.updateSettings}
            highlightedSettingId={highlightedSettingsTargetId}
          />
        </section>
      ) : null}
    </div>
  )
}

it('uses the runtime environment name and retains explicit host-copy precedence', () => {
  useAppStore.setState({
    projectGroupingUpgradeTipAudience: { ...audience, hostId: 'runtime:server' },
    runtimeEnvironments: [
      {
        id: 'server',
        name: 'Build server',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [
          {
            id: 'socket',
            kind: 'websocket',
            label: 'Server',
            endpoint: 'ws://server',
            deviceToken: 'fixture',
            publicKeyB64: 'fixture'
          }
        ],
        preferredEndpointId: 'socket'
      }
    ]
  })
  expect(getLocalizedContextualTourStepCopy('project-grouping-upgrade')?.body).toContain(
    'on Build server'
  )
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      hostSettingOverrides: { 'runtime:server': { displayLabel: 'My server' } }
    }
  })
  expect(getLocalizedContextualTourStepCopy('project-grouping-upgrade')?.body).toContain(
    'on My server'
  )
})
