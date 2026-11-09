// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import type { ChatUiLaunchTipCohort } from '../../../../shared/telemetry-settings-types'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

import FeatureTipsModal from './FeatureTipsModal'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../settings/agents/AgentsPane', () => ({ AgentsPane: () => <p>Per-agent controls</p> }))
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

describe('Chat UI is here tip', () => {
  it.each(['chat-ui-off', 'chat-ui-on'] as const)(
    'opens the Chat UI settings switch from %s',
    (variant) => {
      openTip(variant)
      const settingsLink = container.querySelector<HTMLButtonElement>('button.inline')
      expect(settingsLink).toBeDefined()
      act(() => settingsLink?.click())
      expect(useAppStore.getState().activeModal).toBe('none')
      expect(useAppStore.getState().settingsNavigationTarget).toMatchObject({
        pane: 'chat',
        sectionId: 'chat-launch-default'
      })
      expect(updateSettingsOrThrow).not.toHaveBeenCalled()
    }
  )
})
