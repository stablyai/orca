// @vitest-environment happy-dom

import { act, useCallback, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import type { ChatUiLaunchTipCohort } from '../../../../shared/telemetry-settings-types'
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

function openTip(
  variant: ChatUiLaunchTipVariant,
  cohort?: ChatUiLaunchTipCohort,
  buttonEmphasis?: 'normal' | 'swapped'
): void {
  useAppStore.setState({
    activeModal: 'feature-tips',
    modalData: { tipId: 'chat-ui-here', source: 'app_open' },
    chatUiLaunchTipVariant: variant,
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: variant === 'chat-ui-on' ? 'chat' : 'terminal',
      activeRuntimeEnvironmentId: 'paired',
      nativeChatProviders: { codex: false },
      telemetry: {
        optedIn: true,
        installId: 'install',
        existedBeforeTelemetryRelease: true,
        chatUiLaunchTipCohort: cohort,
        chatUiLaunchTipButtonEmphasis: buttonEmphasis
      },
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
  const consumeSettingsNavigation = useCallback<
    Parameters<typeof useSettingsPageEffects>[0]['consumeSettingsNavigation']
  >((target) => {
    setSettingsHostChoice((previous) => target.hostScope ?? previous)
  }, [])
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
      consumeSettingsNavigation,
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

  it.each(['treatment', 'treatment-swapped-buttons'] as const)(
    'swaps order and emphasis while preserving both actions in %s',
    async (cohort) => {
      openTip('chat-ui-off', cohort)
      const swapped = cohort === 'treatment-swapped-buttons'
      expect(footerButtons().map((button) => [button.textContent, button.dataset.variant])).toEqual(
        swapped
          ? [
              ['Use Chat UI', 'ghost'],
              ['Stay in terminal', 'default']
            ]
          : [
              ['Stay in terminal', 'ghost'],
              ['Use Chat UI', 'default']
            ]
      )
      act(() =>
        footerButtons()
          .find((button) => button.textContent === 'Stay in terminal')
          ?.click()
      )
      expect(useAppStore.getState().activeModal).toBe('none')
      expect(track).toHaveBeenLastCalledWith('chat_ui_feature_tip_action', {
        variant: 'chat_ui_off',
        action: 'stay_in_terminal'
      })

      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
      openTip('chat-ui-off', cohort)
      await act(async () =>
        footerButtons()
          .find((button) => button.textContent === 'Use Chat UI')
          ?.click()
      )
      expect(useAppStore.getState().activeModal).toBe('none')
      expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({ agentDefaultSurface: 'chat' })
      expect(updateSettings).not.toHaveBeenCalled()
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
        variant: 'chat_ui_off',
        action: 'use_chat_ui'
      })
      expect(track).toHaveBeenLastCalledWith('agent_default_surface_changed', {
        from_mode: 'terminal',
        to_mode: 'chat',
        source: 'launch_card',
        launch_tip_shown: true
      })
    }
  )

  it.each([
    'treatment',
    'treatment-swapped-buttons',
    'treatment-center',
    'treatment-live-switch'
  ] as const)(
    'always emphasizes Got it for chat users in %s, while allowing a switch to terminal',
    async (cohort) => {
      openTip('chat-ui-on', cohort, 'swapped')
      expect(footerButtons().map((button) => [button.textContent, button.dataset.variant])).toEqual(
        [
          ['Switch to terminal', 'ghost'],
          ['Got it', 'default']
        ]
      )
      await act(async () =>
        footerButtons()
          .find((button) => button.textContent === 'Got it')
          ?.click()
      )
      expect(useAppStore.getState().activeModal).toBe('none')
      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
      expect(updateSettings).not.toHaveBeenCalled()

      openTip('chat-ui-on', cohort, 'swapped')
      await act(async () =>
        footerButtons()
          .find((button) => button.textContent === 'Switch to terminal')
          ?.click()
      )
      expect(useAppStore.getState().activeModal).toBe('none')
      expect(updateSettingsOrThrow).toHaveBeenCalledExactlyOnceWith({
        agentDefaultSurface: 'terminal'
      })
      expect(track).toHaveBeenCalledWith('chat_ui_feature_tip_action', {
        variant: 'chat_ui_on',
        action: 'switch_to_terminal'
      })
      expect(track).toHaveBeenLastCalledWith('agent_default_surface_changed', {
        from_mode: 'chat',
        to_mode: 'terminal',
        source: 'launch_card',
        launch_tip_shown: true
      })
    }
  )

  it('reports a terminal save failure without recording a successful switch', async () => {
    openTip('chat-ui-on')
    updateSettingsOrThrow.mockRejectedValueOnce(new Error('disk unavailable'))
    await act(async () =>
      footerButtons()
        .find((button) => button.textContent === 'Switch to terminal')
        ?.click()
    )
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Could not switch to terminal. Choose Terminal in Settings → Agents.'
    )
    expect(track).not.toHaveBeenCalledWith(
      'chat_ui_feature_tip_action',
      expect.objectContaining({ action: 'switch_to_terminal' })
    )
    expect(track).not.toHaveBeenCalledWith('agent_default_surface_changed', expect.anything())
  })

  it.each(['chat-ui-off', 'chat-ui-on'] as const)(
    'keeps the saved %s button choices when the current default differs',
    (variant) => {
      openTip(variant)
      act(() =>
        useAppStore.setState((state) => ({
          settings: state.settings
            ? {
                ...state.settings,
                agentDefaultSurface: variant === 'chat-ui-on' ? 'terminal' : 'chat'
              }
            : null
        }))
      )
      expect(footerButtons().map((button) => button.textContent)).toEqual(
        variant === 'chat-ui-on'
          ? ['Switch to terminal', 'Got it']
          : ['Stay in terminal', 'Use Chat UI']
      )
    }
  )

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
