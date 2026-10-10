// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { ChatSettingsSection } from './ChatSettingsSection'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { getChatInlineVisualsSearchEntry } from './chat-inline-visuals-search'
import { useSettingsRepoScrollEffects } from './use-settings-repo-scroll-effects'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import type { SettingsTerminalModel } from './use-settings-terminal-model'

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function NavigationHarness({
  enabled,
  initialSection,
  targetSection = 'chat-code-text-size'
}: {
  enabled: boolean
  initialSection: string
  targetSection?: string
}) {
  const [activeSectionId, setActiveSectionId] = useState(initialSection)
  const settings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: enabled }
  const sections = buildSettingsNavigationMetadata({
    isMac: false,
    isWindows: false,
    isWebClient: false,
    nativeChatEnabled: enabled,
    repos: []
  })
  const pendingNavSectionRef = useRef<string | null>('chat')
  const pendingScrollTargetRef = useRef<string | null>(targetSection)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const pendingScrollTargetWatchRef = useRef(null)
  const pendingSubsectionScrollFrameRef = useRef<number | null>(null)
  const repoHooksRequestSeqRef = useRef(0)
  const model: Pick<
    SettingsStoreModel,
    | 'activeSectionId'
    | 'setActiveSectionId'
    | 'pendingNavRequestTick'
    | 'setPendingNavRequestTick'
    | 'repos'
    | 'setRepoHooksMap'
    | 'settingsSearchQuery'
    | 'setSettingsSearchQuery'
  > = {
    activeSectionId,
    setActiveSectionId,
    pendingNavRequestTick: 0,
    setPendingNavRequestTick: vi.fn(),
    repos: [],
    setRepoHooksMap: vi.fn(),
    settingsSearchQuery: '',
    setSettingsSearchQuery: vi.fn()
  }
  const interactions = {
    contentScrollRef,
    pendingNavSectionRef,
    pendingScrollTargetRef,
    pendingScrollTargetWatchRef,
    pendingSubsectionScrollFrameRef,
    repoHooksRequestSeqRef
  }
  const terminal: Pick<SettingsTerminalModel, 'neededRepos'> = { neededRepos: [] }
  useSettingsRepoScrollEffects(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Supplies every model field read by this hook; no repos need loading.
    model as SettingsStoreModel,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Supplies every interaction ref read by this hook.
    interactions as SettingsInteractionController,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook only reads the visible navigation sections and IDs.
    {
      visibleNavSections: sections,
      visibleSectionIds: new Set(sections.map((s) => s.id))
    } as SettingsNavigationModel,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This hook only reads neededRepos; an empty list skips remote loading.
    terminal as SettingsTerminalModel
  )
  return (
    <ActiveSettingsSectionProvider value={activeSectionId}>
      <output aria-label="Selected settings page">{activeSectionId}</output>
      <ChatSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        writeSourceControlAiSettings={async () => {}}
        searchEntries={[
          ...getChatAppearanceSearchEntries(),
          getChatNamingSearchEntry(),
          getChatInlineVisualsSearchEntry()
        ]}
        showDesktopOnlySettings
        isMounted
      />
    </ActiveSettingsSectionProvider>
  )
}

describe('Chat settings deep links', () => {
  it('activates Chat and scrolls to Inline visuals from another settings page', async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const { container } = render(
      <NavigationHarness enabled initialSection="appearance" targetSection="chat-inline-visuals" />
    )
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Selected settings page' }).textContent).toBe(
        'chat'
      )
    })
    const visuals = container.querySelector('#chat-inline-visuals')
    expect(visuals?.querySelector('[role="switch"]')).toBe(
      screen.getByRole('switch', { name: 'Toggle inline visuals' })
    )
    await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(visuals))
  })

  it('activates Chat and renders the moved row for a deep link', async () => {
    render(<NavigationHarness enabled initialSection="appearance" />)
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Selected settings page' }).textContent).toBe(
        'chat'
      )
    })
    expect(screen.getByRole('spinbutton', { name: 'Code text size' })).toBeTruthy()
  })

  it('activates Chat and scrolls to the separate naming section for its deep link', async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const { container } = render(
      <NavigationHarness enabled initialSection="appearance" targetSection="chat-names" />
    )
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Selected settings page' }).textContent).toBe(
        'chat'
      )
    })
    const names = container.querySelector('#chat-names')
    const appearance = container.querySelector('#chat-appearance')
    expect(names?.parentElement).toBe(appearance?.parentElement)
    expect(names?.querySelector('[role="switch"]')).toBe(
      screen.getByRole('switch', { name: 'Name chats automatically' })
    )
    await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(names))
  })

  it('falls back through the existing navigation rule when a hidden Chat page is selected', async () => {
    const { container } = render(<NavigationHarness enabled={false} initialSection="chat" />)
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Selected settings page' }).textContent).toBe(
        'agents'
      )
    })
    expect(container.querySelector('#chat')).toBeNull()
  })

  it('keeps the current visible page for a deep link to hidden Chat', () => {
    const { container } = render(<NavigationHarness enabled={false} initialSection="appearance" />)
    expect(screen.getByRole('status', { name: 'Selected settings page' }).textContent).toBe(
      'appearance'
    )
    expect(container.querySelector('#chat')).toBeNull()
  })
})
