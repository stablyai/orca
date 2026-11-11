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
import { GeneralPane } from '../settings/general/GeneralPane'
import type { GeneralSubPage } from '../settings/general/general-sub-pages'
import { SettingsTargetHighlightProvider } from '../settings/section-layout/settings-target-highlight'
import { TooltipProvider } from '../ui/tooltip'
import { useSettingsPageEffects } from '../settings/page/use-settings-page-effects'
import { useSettingsRepoScrollEffects } from '../settings/navigation/use-settings-repo-scroll-effects'
import type { SettingsStoreModel } from '../settings/page/use-settings-store-model'
import type { SettingsInteractionController } from '../settings/page/use-settings-interaction-controller'
import type { SettingsNavigationModel } from '../settings/navigation/use-settings-navigation-model'
import type { SettingsTerminalModel } from '../settings/page/use-settings-terminal-model'
import { useProjectGroupingUpgradeTip } from './use-project-grouping-upgrade-tip'
import { useSettingsHostNavigation } from '../settings/host-scope/use-settings-host-navigation'

const audience = {
  version: 1 as const,
  membership: 'eligible' as const,
  projectId: 'github:org/app',
  projectCount: 1
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
    activeModal: 'none',
    refreshRemoteServerUpdates: async () => {}
  })
  const header = document.createElement('div')
  header.dataset.contextualTourTarget = 'project-grouping-upgrade'
  header.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 200, height: 30 })
  document.body.appendChild(header)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document
    .querySelectorAll('[data-contextual-tour-target="project-grouping-upgrade"]')
    .forEach((element) => element.remove())
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each(['Dismiss tour', 'Settings'])(
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
    expect(
      await screen.findByText(
        'Orca now groups multiple checkouts of the same repo into one project.'
      )
    ).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: action }))
    expect(useAppStore.getState().contextualToursSeenIds).toContain('project-grouping-upgrade')
    expect(
      screen.queryByText('Orca now groups multiple checkouts of the same repo into one project.')
    ).toBeNull()
    if (action === 'Settings') {
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
        contextualToursStartedThisSession: [],
        contextualToursSeenIds: [...seen]
      })
    )
    vi.useFakeTimers()
    render(<Tip />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(
      screen.queryByText('Orca now groups multiple checkouts of the same repo into one project.')
    ).toBeNull()
  }
)

it('consumes the audience when a separate mode is chosen before first display', async () => {
  useAppStore.setState({ settings: { ...getDefaultSettings(''), projectGroupingMode: 'host' } })
  render(<Tip />)
  await act(async () => {})
  expect(useAppStore.getState().contextualToursSeenIds).toContain('project-grouping-upgrade')
  act(() => useAppStore.setState({ settings: getDefaultSettings('') }))
  await act(async () => {})
  expect(
    screen.queryByText('Orca now groups multiple checkouts of the same repo into one project.')
  ).toBeNull()
})

vi.mock('../settings/updates/GeneralUpdateSettingsSection', () => ({
  GeneralUpdateSettingsSection: () => null
}))
vi.mock('../settings/cli/install/CliSection', () => ({ CliSection: () => null }))
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
  const { consumeSettingsNavigation } = useSettingsHostNavigation(state.settingsNavigationTarget)
  const [activeSectionId, setActiveSectionId] = useState('appearance')
  const [mountedSectionIds, setMountedSectionIds] = useState(new Set<string>())
  const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
  const [highlightedSettingsTarget, setHighlightedSettingsTarget] = useState<{
    id: string
  } | null>(null)
  const [generalSubPage, setGeneralSubPage] = useState<GeneralSubPage | null>(null)
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
    consumeSettingsNavigation,
    activeSectionId,
    setActiveSectionId,
    mountedSectionIds,
    setMountedSectionIds,
    pendingNavRequestTick,
    setPendingNavRequestTick,
    highlightedSettingsTarget,
    setHighlightedSettingsTarget,
    generalSubPage,
    setGeneralSubPage,
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
          <TooltipProvider>
            <SettingsTargetHighlightProvider value={highlightedSettingsTarget?.id ?? null}>
              <GeneralPane
                settings={state.settings!}
                updateSettings={state.updateSettings}
                fontSuggestions={[]}
                subPage={generalSubPage}
                onSelectSubPage={setGeneralSubPage}
              />
            </SettingsTargetHighlightProvider>
          </TooltipProvider>
        </section>
      ) : null}
    </div>
  )
}
