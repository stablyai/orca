// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../../shared/developer-permissions-types'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'
import type { VoiceSettings } from '../../../../../shared/speech-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, message: vi.fn() }
}))

import { VoiceMicrophoneSetting } from './VoiceMicrophoneSetting'

const voiceSettings: VoiceSettings = {
  ...getDefaultVoiceSettings(),
  enabled: true
}

function namedError(name: string, message = 'boom'): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function installMediaDevices(getUserMedia: () => Promise<Pick<MediaStream, 'getTracks'>>): void {
  Object.assign(navigator, {
    mediaDevices: {
      getUserMedia: vi.fn(getUserMedia),
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
}

function installPermissionsApi(result: DeveloperPermissionRequestResult | Error): void {
  Object.assign(window, {
    api: {
      developerPermissions: {
        request: vi.fn(async () => {
          if (result instanceof Error) {
            throw result
          }
          return result
        })
      }
    }
  })
}

let container: HTMLDivElement
let root: Root

async function renderSetting(settings: VoiceSettings = voiceSettings): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <VoiceMicrophoneSetting voiceSettings={settings} onUpdateVoiceSettings={() => {}} />
    )
  })
}

async function clickAllowAccess(): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === 'Allow access'
  )
  if (!button) {
    throw new Error('Allow access button not rendered')
  }
  await act(async () => {
    button.click()
  })
}

function alertText(): string {
  return container.querySelector('[role="alert"]')?.textContent ?? ''
}

describe('VoiceMicrophoneSetting access failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installPermissionsApi({ id: 'microphone', status: 'denied', openedSystemSettings: false })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('names the missing-hardware case instead of a permission instruction', async () => {
    installMediaDevices(async () => {
      throw namedError('NotFoundError')
    })

    await renderSetting()
    await clickAllowAccess()

    expect(window.api.developerPermissions.request).not.toHaveBeenCalled()
    expect(alertText()).toBe('No microphone was found. Connect one, then try again.')
  })

  it('opens a stream after the OS grant so the device list is not left empty', async () => {
    let calls = 0
    let streamOpened = false
    const getUserMedia = vi.fn(async () => {
      calls += 1
      // After OS permission, reopen a stream so this renderer can enumerate device labels.
      if (calls === 1) {
        throw namedError('NotAllowedError')
      }
      streamOpened = true
      return { getTracks: () => [] }
    })
    Object.assign(navigator, {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn(async () =>
          streamOpened
            ? [{ kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in Microphone' }]
            : []
        ),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }
    })
    installPermissionsApi({ id: 'microphone', status: 'granted', openedSystemSettings: false })

    await renderSetting()
    await clickAllowAccess()

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    // Verify the granted permission populates devices instead of leaving access guidance visible.
    expect(container.textContent).not.toContain('Allow microphone access to list input devices.')
  })

  it('keeps a second browser denial classified as a permission error', async () => {
    installMediaDevices(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    })
    installPermissionsApi({ id: 'microphone', status: 'granted', openedSystemSettings: false })

    await renderSetting()
    await clickAllowAccess()

    expect(alertText()).toBe(
      'Microphone access is blocked. Grant it in your system settings, then try again.'
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
