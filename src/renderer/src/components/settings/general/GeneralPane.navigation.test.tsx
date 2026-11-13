// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '@/store'
import { GeneralPane } from './GeneralPane'
import type { GeneralSubPage } from './general-sub-pages'
import { useSettingsRepoScrollEffects } from '../navigation/use-settings-repo-scroll-effects'
import type { SettingsStoreModel } from '../page/use-settings-store-model'
import type { SettingsInteractionController } from '../page/use-settings-interaction-controller'
import type { SettingsNavigationModel } from '../navigation/use-settings-navigation-model'
import type { SettingsTerminalModel } from '../page/use-settings-terminal-model'
import { TooltipProvider } from '../../ui/tooltip'

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function NavigationHarness({
  initialPage = 'editor',
  onWrite = vi.fn()
}: {
  initialPage?: GeneralSubPage
  onWrite?: (updates: Partial<ReturnType<typeof getDefaultSettings>>) => void
}) {
  const [settings, setSettings] = useState(() => ({
    ...getDefaultSettings('/tmp'),
    editorMinimapEnabled: true
  }))
  const [generalSubPage, setGeneralSubPage] = useState<GeneralSubPage | null>(initialPage)
  const [activeSectionId, setActiveSectionId] = useState('general')
  const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
  const query = useAppStore((state) => state.settingsSearchQuery)
  const setQuery = useAppStore((state) => state.setSettingsSearchQuery)
  const pendingNavSectionRef = useRef<string | null>(null)
  const pendingScrollTargetRef = useRef<string | null>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const pendingScrollTargetWatchRef = useRef(null)
  const pendingSubsectionScrollFrameRef = useRef<number | null>(null)
  const repoHooksRequestSeqRef = useRef(0)
  const requestTarget = (sectionId: string) => {
    pendingNavSectionRef.current = 'general'
    pendingScrollTargetRef.current = sectionId
    setPendingNavRequestTick((tick) => tick + 1)
  }
  const model = {
    activeSectionId,
    setActiveSectionId,
    generalSubPage,
    setGeneralSubPage,
    setHighlightedSettingsTarget: vi.fn(),
    pendingNavRequestTick,
    setPendingNavRequestTick,
    repos: [],
    setRepoHooksMap: vi.fn(),
    settingsSearchQuery: query,
    setSettingsSearchQuery: setQuery
  }
  useSettingsRepoScrollEffects(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every model field this navigation hook reads is supplied; repository loading is inactive.
    model as unknown as SettingsStoreModel,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Supplies the production hook's complete navigation-ref contract.
    {
      contentScrollRef,
      pendingNavSectionRef,
      pendingScrollTargetRef,
      pendingScrollTargetWatchRef,
      pendingSubsectionScrollFrameRef,
      repoHooksRequestSeqRef
    } as SettingsInteractionController,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: General is the only visible section in this focused renderer harness.
    {
      visibleNavSections: [{ id: 'general' }],
      visibleSectionIds: new Set(['general'])
    } as SettingsNavigationModel,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: No repository capability requests are needed for General navigation.
    { neededRepos: [] } as unknown as SettingsTerminalModel
  )
  return (
    <TooltipProvider>
      <button onClick={() => requestTarget('general-open-in-apps')}>Open app settings link</button>
      <GeneralPane
        settings={settings}
        subPage={generalSubPage}
        fontSuggestions={[]}
        updateSettings={(updates) => {
          onWrite(updates)
          setSettings((current) => ({ ...current, ...updates }))
        }}
        onSelectSubPage={(page, sectionId) => {
          if (sectionId) {
            requestTarget(sectionId)
          } else {
            setGeneralSubPage(page)
            setQuery('')
          }
        }}
      />
    </TooltipProvider>
  )
}

function renderNavigationHarness(props: Parameters<typeof NavigationHarness>[0] = {}) {
  return render(<NavigationHarness {...props} />)
}

it('opens an old subsection link from another child, including repeated selection', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  const { container } = renderNavigationHarness()
  fireEvent.click(screen.getByRole('button', { name: 'Open app settings link' }))
  const add = await screen.findByRole('button', { name: 'Add app' })
  const target = container.querySelector('#general-open-in-apps')
  expect(target?.contains(add)).toBe(true)
  await waitFor(() => expect(scroll.mock.contexts).toContain(target))
  scroll.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Open app settings link' }))
  await waitFor(() => expect(scroll.mock.contexts).toContain(target))
})
