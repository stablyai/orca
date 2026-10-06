// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { ChatSettingsSection } from './ChatSettingsSection'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { getChatAppearanceSearchEntries } from './chat-appearance-search'
import { useSettingsRepoScrollEffects } from './use-settings-repo-scroll-effects'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import type { SettingsTerminalModel } from './use-settings-terminal-model'

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
afterEach(cleanup)

function NavigationHarness({
  enabled,
  initialSection
}: {
  enabled: boolean
  initialSection: string
}) {
  const [activeSectionId, setActiveSectionId] = useState(initialSection)
  const settings = { ...getDefaultSettings('/tmp'), experimentalStructuredNativeChat: enabled }
  const sections = buildSettingsNavigationMetadata({
    isMac: false,
    isWindows: false,
    isWebClient: false,
    experimentalStructuredNativeChat: enabled,
    repos: []
  })
  const pendingNavSectionRef = useRef<string | null>('chat')
  const pendingScrollTargetRef = useRef<string | null>('chat-code-text-size')
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
        searchEntries={getChatAppearanceSearchEntries()}
        isMounted
      />
    </ActiveSettingsSectionProvider>
  )
}

describe('Chat settings deep links', () => {
  it('activates Chat and renders the moved row for a deep link', async () => {
    render(<NavigationHarness enabled initialSection="appearance" />)
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Selected settings page' }).textContent).toBe(
        'chat'
      )
    })
    expect(screen.getByRole('spinbutton', { name: 'Code text size' })).toBeTruthy()
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
