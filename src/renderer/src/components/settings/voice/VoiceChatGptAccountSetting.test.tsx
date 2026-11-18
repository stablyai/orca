// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDefaultSettings,
  getDefaultVoiceSettings
} from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useAppStore } from '@/store'
import { VoicePane } from './VoicePane'
import { VoiceChatGptAccountSettings } from './VoiceChatGptAccountSetting'
import { TooltipProvider } from '../../ui/tooltip'

vi.mock('./VoiceCleanupSettings', () => ({ VoiceCleanupSettings: () => null }))

const originalState = useAppStore.getState()
const originalApi = window.api
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices')
  }
  vi.unstubAllGlobals()
})

describe('dictation account selection', () => {
  it('keeps a removed selection until explicitly choosing a host account', async () => {
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        speech: {
          getChatGptAccounts: async () => [
            { id: 'personal', label: 'personal@example.test' },
            { id: 'work', label: 'work@example.test' }
          ]
        }
      }
    })
    Element.prototype.scrollIntoView = vi.fn()
    const update = vi.fn()
    render(
      <VoiceChatGptAccountSettings
        voiceSettings={{ ...getDefaultVoiceSettings(), chatGptAccountId: 'deleted' }}
        onUpdateVoiceSettings={update}
      />
    )
    const trigger = screen.getByRole('combobox')
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
    expect(update).not.toHaveBeenCalled()
    expect(trigger.textContent).toContain('deleted')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    await screen.findByRole('option', { name: 'work@example.test' })
    fireEvent.click(screen.getByRole('option', { name: 'work@example.test' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ chatGptAccountId: 'work' }))
  })

  it('keeps account persistence isolated from overlapping microphone saves', async () => {
    let persisted: GlobalSettings = {
      ...getDefaultSettings('/synthetic'),
      voice: { ...getDefaultVoiceSettings(), enabled: true, chatGptAccountId: 'personal' }
    }
    const accountReply = Promise.withResolvers<void>()
    const set = vi.fn(async (updates: Partial<GlobalSettings>) => {
      persisted = { ...persisted, ...updates }
      return persisted
    })
    set.mockImplementationOnce(async (updates) => {
      await accountReply.promise
      persisted = { ...persisted, ...updates }
      return persisted
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        settings: { set },
        speech: {
          getCatalog: async () => [],
          getOpenAiApiKeyStatus: async () => ({ configured: false, protection: null }),
          onDownloadProgress: () => () => {},
          getChatGptAccounts: async () => [
            { id: 'personal', label: 'personal@example.test' },
            { id: 'work', label: 'work@example.test' }
          ]
        }
      }
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' },
          { kind: 'audioinput', deviceId: 'headset', label: 'Headset microphone' }
        ],
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    })
    Element.prototype.scrollIntoView = vi.fn()
    useAppStore.setState({
      settings: persisted,
      refreshModelStates: vi.fn(async () => {})
    })
    function Pane(): React.JSX.Element {
      const settings = useAppStore((state) => state.settings)!
      return (
        <VoicePane
          settings={settings}
          updateSettings={useAppStore.getState().updateSettings}
          writeSourceControlAiSettings={async () => {}}
        />
      )
    }
    render(
      <TooltipProvider>
        <Pane />
      </TooltipProvider>
    )
    fireEvent.click(await screen.findByRole('radio', { name: 'Cloud' }))
    const account = await screen.findByRole('combobox', { name: 'ChatGPT account' })
    await waitFor(() => expect(account.hasAttribute('disabled')).toBe(false))
    fireEvent.keyDown(account, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'work@example.test' }))
    await waitFor(() => expect(set).toHaveBeenCalled())
    const microphone = screen.getByRole('combobox', { name: 'Microphone' })
    fireEvent.keyDown(microphone, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'USB microphone' }))
    await act(async () => accountReply.reject(new Error('Account write rejected')))
    await screen.findByRole('alert')
    await waitFor(() =>
      expect(persisted.voice).toMatchObject({
        chatGptAccountId: 'personal',
        microphoneDeviceId: 'usb',
        microphoneDeviceLabel: 'USB microphone'
      })
    )

    const successReply = Promise.withResolvers<void>()
    set.mockImplementationOnce(async (updates) => {
      await successReply.promise
      persisted = { ...persisted, ...updates }
      return persisted
    })
    await waitFor(() => expect(account.hasAttribute('disabled')).toBe(false))
    fireEvent.keyDown(account, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'work@example.test' }))
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          voice: expect.objectContaining({ chatGptAccountId: 'work' })
        })
      )
    )
    fireEvent.keyDown(microphone, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Headset microphone' }))
    await act(async () => successReply.resolve())
    await waitFor(() =>
      expect(persisted.voice).toMatchObject({
        chatGptAccountId: 'work',
        microphoneDeviceId: 'headset',
        microphoneDeviceLabel: 'Headset microphone'
      })
    )
    await waitFor(() => expect(account.hasAttribute('disabled')).toBe(false))
    expect(account.textContent).toContain('work@example.test')
  })
})
