// @vitest-environment happy-dom

import { act, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useSettingsPageEffects } from '../settings/use-settings-page-effects'
import { resolveSettingsHostScope } from '../settings/settings-host-scope'
import { renderAgentsSettingsSection } from '../settings/settings-capability-section-renderers'
import { ActiveSettingsSectionProvider } from '../settings/SettingsSection'
import type { SettingsRenderContext } from '../settings/settings-render-context'
import { AGENT_DEFAULT_SURFACE_SECTION_ID } from '../settings/agents-search'
import { chatDemoRevealTokens, getChatDemoCopy } from './chat-ui-here-feature-tip-demo'
import { FeatureTipActions } from './FeatureTipActions'
import FeatureTipsModal from './FeatureTipsModal'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../settings/AgentsPane', () => ({ AgentsPane: () => <p>Per-agent controls</p> }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const updateSettings = vi.fn()
const updateSettingsOrThrow = vi.fn()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  root = createRoot(container)
  vi.mocked(toast.error).mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: { get: () => ({ platform: 'darwin' }) } }
  })
  updateSettings.mockReset()
  vi.mocked(track).mockReset()
  updateSettingsOrThrow.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root.unmount())
})

function openTip(variant: ChatUiLaunchTipVariant): void {
  useAppStore.setState({
    activeModal: 'feature-tips',
    modalData: { tipId: 'chat-ui-here', source: 'app_open' },
    chatUiLaunchTipVariant: variant,
    settings: createGlobalSettingsFixture({
      activeRuntimeEnvironmentId: 'paired',
      nativeChatProviders: { codex: false },
      aiVaultSearch: { enabled: false, historyDays: null }
    }),
    markFeatureTipsSeen: vi.fn(),
    updateSettings,
    updateSettingsOrThrow
  })
  act(() => root.render(<FeatureTipsModal />))
}

function footerButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('footer button'))
}

// Exercise the production target-consumption effect, including a retained host selection.
function SettingsOwner({ retained }: { retained: boolean }): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)!
  const settingsNavigationTarget = useAppStore((state) => state.settingsNavigationTarget)
  const [choice, setSettingsHostChoice] = useState<RuntimeClientTarget | null>(
    retained ? { kind: 'environment', environmentId: 'paired' } : null
  )
  const pendingScrollTargetRef = useRef<string | null>(null)
  const scope = resolveSettingsHostScope({
    choice,
    defaultEnvironmentId: settings.activeRuntimeEnvironmentId,
    savedEnvironmentIds: ['paired'],
    catalogHydrated: true
  })
  useSettingsPageEffects(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all fields read by page effects are supplied; unrelated model fields are unused.
    {
      settings,
      settingsNavigationTarget,
      setSettingsHostChoice,
      clearSettingsTarget: useAppStore.getState().clearSettingsTarget,
      fetchSettings: vi.fn(),
      fetchKeybindings: vi.fn(),
      keybindings: null,
      activeSectionId: 'agents',
      showDesktopOnlySettings: false,
      setVoiceModelStatesLoading: vi.fn(),
      repoIdToHostSelection: new Map(),
      repoIdToRepresentative: new Map(),
      settingsProjectList: [],
      setHighlightedSettingsTargetId: vi.fn(),
      setMountedSectionIds: vi.fn(),
      setPendingNavRequestTick: vi.fn()
    } as unknown as Parameters<typeof useSettingsPageEffects>[0],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refs/callbacks cover every active page effect; no source-control edit or key event is generated.
    {
      pendingNavSectionRef: useRef(null),
      pendingScrollTargetRef,
      shortcutsEscapeConfirmUntilRef: useRef(0),
      searchInputRef: useRef(null),
      hasUnsavedSourceControlAiPromptChangesRef: useRef(false),
      closeSettingsPageWithPromptGuard: vi.fn(),
      promptDiscardSourceControlAiPromptChanges: vi.fn()
    } as unknown as Parameters<typeof useSettingsPageEffects>[1]
  )
  return (
    <>
      <output>{pendingScrollTargetRef.current}</output>
      <ActiveSettingsSectionProvider value="agents">
        {renderAgentsSettingsSection(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every field read by the Agents section renderer; unrelated Settings sections never run.
          {
            model: { settings, settingsHostScope: scope, updateSettings },
            navigation: { getSectionSearchEntries: () => [] },
            terminal: { localWindowsRuntimeCapabilities: {} },
            view: { isSectionMounted: () => true }
          } as unknown as SettingsRenderContext
        )}
      </ActiveSettingsSectionProvider>
    </>
  )
}

describe('Chat UI is here tip', () => {
  it.each([
    ['chat-ui-off', false],
    ['chat-ui-on', true]
  ] as const)(
    'opens the local default tiles from %s with a paired Settings host',
    (variant, retained) => {
      openTip(variant)
      const settingsLink = container.querySelector<HTMLButtonElement>('button.inline')
      expect(settingsLink).toBeDefined()
      act(() => settingsLink?.click())
      expect(useAppStore.getState().activeModal).toBe('none')
      act(() => root.render(<SettingsOwner retained={retained} />))
      expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2)
      expect(container.querySelector('output')?.textContent).toBe(AGENT_DEFAULT_SURFACE_SECTION_ID)
      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    }
  )

  it('reports a checked-save rejection once after consuming/closing the tip, without success telemetry', async () => {
    openTip('chat-ui-off')
    updateSettingsOrThrow.mockRejectedValueOnce(new Error('disk unavailable'))
    await act(async () => footerButtons()[1]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(useAppStore.getState().markFeatureTipsSeen).toHaveBeenCalledExactlyOnceWith([
      'chat-ui-here'
    ])
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Could not turn on Chat UI. Choose Chat in Settings → Agents.'
    )
    expect(track).not.toHaveBeenCalledWith(
      'chat_ui_feature_tip_action',
      expect.objectContaining({ action: 'use_chat_ui' })
    )
  })

  it('makes Chat the default with Use Chat UI, leaving agents set for themselves alone, and nothing with Stay in terminal', async () => {
    openTip('chat-ui-off')
    expect(footerButtons().map((button) => button.textContent)).toEqual([
      'Stay in terminal',
      'Use Chat UI'
    ])
    act(() => footerButtons()[0]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(track).toHaveBeenLastCalledWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'stay_in_terminal'
    })

    openTip('chat-ui-off')
    await act(async () => footerButtons()[1]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'chat' })
    expect(updateSettings).not.toHaveBeenCalled()
    expect(track).toHaveBeenLastCalledWith('chat_ui_feature_tip_action', {
      variant: 'chat_ui_off',
      action: 'use_chat_ui'
    })
  })

  it('offers chat users a single Got it that closes without saving', async () => {
    openTip('chat-ui-on')
    expect(footerButtons().map((button) => button.textContent)).toEqual(['Got it'])
    await act(async () => footerButtons()[0]?.click())
    expect(useAppStore.getState().activeModal).toBe('none')
    expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('renders nothing for a profile outside the audience, even when named', () => {
    openTip('none')
    expect(container.innerHTML).toBe('')
  })

  it('reveals the reply word by word around an untranslated file link, in any script', () => {
    const reply = getChatDemoCopy().reply
    expect(reply.map((token) => token.text).join('')).toBe(
      'Login starts in auth.ts: the browser posts to /login, the server checks the password and creates a session, then redirects you to the app. Here’s the flow:'
    )
    expect(reply.filter((token) => token.link)).toEqual([{ text: 'auth.ts', link: true }])
    expect(reply[0]).toEqual({ text: 'Login ' })
    // Japanese has no spaces; it still streams in several steps instead of one block.
    const japanese = 'ブラウザが /login に送信し、サーバーがパスワードを確認します。'
    const tokens = chatDemoRevealTokens(japanese)
    expect(tokens.map((token) => token.text).join('')).toBe(japanese)
    expect(tokens.length).toBeGreaterThan(5)
  })

  it('keeps the other tips’ default secondary label', () => {
    const tip = FEATURE_TIPS.find((entry) => entry.id === 'voice-dictation')
    if (!tip) {
      throw new Error('Missing voice dictation tip fixture')
    }
    act(() =>
      root.render(
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={false}
          onPrimaryAction={vi.fn()}
          onSkip={vi.fn()}
        />
      )
    )
    expect(container.querySelector('button')?.textContent).toBe('Maybe Later')
  })
})
