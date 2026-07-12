// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { TooltipProvider } from '@/components/ui/tooltip'
import { handleVoiceDictationToggle, VoicePane } from './VoicePane'

const { useAppStoreMock, useShortcutLabelMock } = vi.hoisted(() => ({
  useAppStoreMock: vi.fn(),
  useShortcutLabelMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: useShortcutLabelMock
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn()
  }
}))

const deniedMicrophoneResult: DeveloperPermissionRequestResult = {
  id: 'microphone',
  status: 'denied',
  openedSystemSettings: false
}

function makeSettings(
  voiceEnabled: boolean,
  voiceOverrides: Partial<ReturnType<typeof getDefaultVoiceSettings>> = {}
): GlobalSettings {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled,
      ...voiceOverrides
    }
  } as GlobalSettings
}

function installWindowApi(
  requestMicrophonePermission: () => Promise<DeveloperPermissionRequestResult>,
  options: { sonioxConfigured?: boolean } = {}
) {
  Object.assign(window, {
    api: {
      developerPermissions: {
        request: vi.fn(requestMicrophonePermission)
      },
      speech: {
        getCatalog: vi.fn(async () => []),
        getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: false })),
        saveOpenAiApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenAiApiKey: vi.fn(async () => ({ configured: false })),
        getSonioxApiKeyStatus: vi.fn(async () => ({
          configured: options.sonioxConfigured ?? false
        })),
        saveSonioxApiKey: vi.fn(async () => ({ configured: true })),
        clearSonioxApiKey: vi.fn(async () => ({ configured: false })),
        onDownloadProgress: vi.fn(() => () => {}),
        downloadModel: vi.fn()
      }
    }
  })
}

async function renderVoicePane(args: {
  voiceEnabled: boolean
  markFeatureTipsSeen: (ids: string[]) => void
  updateSettings: (updates: Partial<GlobalSettings>) => void
  requestMicrophonePermission?: () => Promise<DeveloperPermissionRequestResult>
  recordFeatureInteraction?: (id: string) => void
  sonioxConfigured?: boolean
}): Promise<{ button: HTMLButtonElement; root: Root; container: HTMLDivElement }> {
  const refreshModelStates = vi.fn()
  useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      modelStates: [],
      refreshModelStates,
      markFeatureTipsSeen: args.markFeatureTipsSeen,
      recordFeatureInteraction: args.recordFeatureInteraction ?? vi.fn(),
      settingsSearchQuery: ''
    })
  )
  useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
  installWindowApi(args.requestMicrophonePermission ?? vi.fn(async () => deniedMicrophoneResult), {
    sonioxConfigured: args.sonioxConfigured
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <VoicePane
          settings={makeSettings(args.voiceEnabled, {
            sonioxApiKeyConfigured: args.sonioxConfigured ?? false
          })}
          updateSettings={args.updateSettings}
        />
      </TooltipProvider>
    )
  })
  // Why: allow getSonioxApiKeyStatus / getCatalog effects to settle before assertions.
  await act(async () => {
    await Promise.resolve()
  })

  const button = container.querySelector<HTMLButtonElement>('button[role="switch"]')
  if (!button) {
    throw new Error('Voice Dictation switch was not rendered')
  }

  return { button, root, container }
}

async function clickSwitch(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('VoicePane dictation switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    useAppStoreMock.mockReset()
    useShortcutLabelMock.mockReset()
  })

  it('clicking the switch marks the voice tip seen before disabling voice settings', async () => {
    const calls: string[] = []
    const requestMicrophonePermission = vi.fn()
    const updateVoiceSettings = vi.fn((updates: { enabled?: boolean }) => {
      calls.push(`settings:${String(updates.enabled)}`)
    })

    await handleVoiceDictationToggle({
      voiceEnabled: true,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateVoiceSettings,
      requestMicrophonePermission
    })

    expect(calls).toEqual(['seen:voice-dictation', 'settings:false'])
    expect(updateVoiceSettings).toHaveBeenCalledWith({ enabled: false })
    expect(requestMicrophonePermission).not.toHaveBeenCalled()
  })

  it('clicking the switch marks the voice tip seen before the disable settings update', async () => {
    const calls: string[] = []
    const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
      calls.push(`settings:${String(updates.voice?.enabled)}`)
    })
    const { button, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateSettings,
      requestMicrophonePermission: vi.fn(async () => deniedMicrophoneResult)
    })

    await clickSwitch(button)
    root.unmount()

    expect(calls).toEqual(['seen:voice-dictation', 'settings:false'])
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ enabled: false })
      })
    )
    expect(window.api.developerPermissions.request).not.toHaveBeenCalled()
  })

  it('clicking the switch marks the voice tip seen before requesting microphone permission', async () => {
    const calls: string[] = []
    const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
      calls.push(`settings:${String(updates.voice?.enabled)}`)
    })
    const { button, root } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateSettings,
      requestMicrophonePermission: async () => {
        calls.push('permission-request')
        return deniedMicrophoneResult
      }
    })

    await clickSwitch(button)
    root.unmount()

    expect(calls).toEqual(['seen:voice-dictation', 'permission-request'])
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('marks the voice tip seen before requesting microphone permission when enabling is denied', async () => {
    const calls: string[] = []
    const updateVoiceSettings = vi.fn((updates: { enabled?: boolean }) => {
      calls.push(`settings:${String(updates.enabled)}`)
    })

    await handleVoiceDictationToggle({
      voiceEnabled: false,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateVoiceSettings,
      requestMicrophonePermission: async () => {
        calls.push('permission-request')
        return deniedMicrophoneResult
      },
      setPermissionPending: (pending) => calls.push(`pending:${String(pending)}`),
      notifyPermissionRequired: () => calls.push('permission-required')
    })

    expect(calls).toEqual([
      'seen:voice-dictation',
      'pending:true',
      'permission-request',
      'permission-required',
      'pending:false'
    ])
    expect(updateVoiceSettings).not.toHaveBeenCalled()
  })

  it('does not record voice feature interaction from the settings switch', async () => {
    const recordFeatureInteraction = vi.fn()
    const { button, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings: vi.fn(),
      recordFeatureInteraction
    })

    await clickSwitch(button)
    root.unmount()

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
  })
})

describe('VoicePane Soniox settings', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    useAppStoreMock.mockReset()
    useShortcutLabelMock.mockReset()
  })

  it('renders the Soniox settings row when an API key is configured', async () => {
    const { container, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings: vi.fn(),
      sonioxConfigured: true
    })

    expect(container.textContent).toContain('Soniox Transcription')
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Replace key'
      )
    ).toBe(true)
    expect(container.querySelector('button[aria-label="Disconnect Soniox API key"]')).not.toBeNull()
    root.unmount()
  })

  it('saves a Soniox API key from the settings dialog', async () => {
    const updateSettings = vi.fn()
    const { container, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings,
      sonioxConfigured: true
    })

    const replaceButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Replace key'
    )
    expect(replaceButton).toBeDefined()
    await act(async () => {
      replaceButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Why: Radix Dialog portals outside the pane container.
    const input = document.querySelector<HTMLInputElement>('#soniox-speech-api-key')
    expect(input).not.toBeNull()
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value'
      )?.set
      nativeInputValueSetter?.call(input, 'soniox-test-key')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save Key'
    )
    expect(saveButton).toBeDefined()
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.speech.saveSonioxApiKey).toHaveBeenCalledWith('soniox-test-key')
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ sonioxApiKeyConfigured: true })
      })
    )
    root.unmount()
  })

  it('clears a configured Soniox API key from the settings row', async () => {
    const updateSettings = vi.fn()
    const { container, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings,
      sonioxConfigured: true
    })

    const disconnect = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disconnect Soniox API key"]'
    )
    expect(disconnect).not.toBeNull()
    await act(async () => {
      disconnect!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.speech.clearSonioxApiKey).toHaveBeenCalledOnce()
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ sonioxApiKeyConfigured: false })
      })
    )
    root.unmount()
  })
})
