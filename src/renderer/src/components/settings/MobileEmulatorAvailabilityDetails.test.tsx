// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IosSetupStatus } from '../../../../shared/emulator-setup-types'
import { MobileEmulatorAvailabilityDetails } from './MobileEmulatorAvailabilityDetails'

const XCODE = {
  appPath: '/Applications/Xcode.app',
  developerDir: '/Applications/Xcode.app/Contents/Developer',
  name: 'Xcode'
}
const IOS_SELECTION: IosSetupStatus = {
  state: 'xcode-selection-required',
  message: 'Xcode is installed, but Command Line Tools are selected.',
  recommendedXcode: XCODE,
  installedXcodes: [XCODE],
  devices: []
}
const ANDROID_MISSING = {
  state: 'sdk-missing' as const,
  message: 'Android Studio and the Android SDK were not found.',
  configuredPath: false,
  studioInstalled: false,
  components: { platformTools: false, emulator: false, systemImages: false }
}

let container: HTMLDivElement
let root: Root
let useXcode: ReturnType<typeof vi.fn>

beforeEach(() => {
  useXcode = vi.fn(async () => ({ ok: true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      emulatorSetup: {
        useInstalledXcode: useXcode,
        finishXcodeSetup: vi.fn(),
        openXcode: vi.fn(async () => ({ ok: true }))
      },
      shell: {
        openUrl: vi.fn(),
        openFilePath: vi.fn(),
        pickDirectory: vi.fn()
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
})

function renderDetails(
  platform: string,
  ios: IosSetupStatus = IOS_SELECTION,
  serveSim: { ok: boolean; message?: string } = { ok: true }
): void {
  act(() => {
    root.render(
      <MobileEmulatorAvailabilityDetails
        availability={{ platform, ios, serveSim, android: ANDROID_MISSING }}
        onSetAndroidSdkPath={vi.fn()}
        onRefresh={vi.fn()}
      />
    )
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(label)
  )
}

describe('MobileEmulatorAvailabilityDetails', () => {
  it('prominently offers the explicit guided action for the CLT-selected macOS state', async () => {
    renderDetails('darwin')
    const action = button('Use Installed Xcode')
    expect(action).toBeTruthy()
    await act(async () => action?.click())
    expect(useXcode).toHaveBeenCalledWith(XCODE.developerDir)
  })

  it.each([
    ['linux', 'SSH/Linux'],
    ['win32', 'Windows/WSL']
  ])('shows no local Xcode action on %s hosts (%s)', (platform) => {
    renderDetails(platform, {
      state: 'unsupported',
      message: 'iOS Simulator is available only on a local Mac.',
      installedXcodes: [],
      devices: []
    })
    expect(button('Use Installed Xcode')).toBeUndefined()
    expect(button('Open Xcode')).toBeUndefined()
    expect(container.textContent).toContain('available only on a local Mac')
  })

  it('hides local actions when the renderer has no local privileged bridge', () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { shell: { openUrl: vi.fn(), openFilePath: vi.fn(), pickDirectory: vi.fn() } }
    })
    renderDetails('darwin')
    expect(button('Use Installed Xcode')).toBeUndefined()
    expect(button('Locate SDK folder')).toBeUndefined()
  })

  it('does not show iOS ready when Orca simulator support fails its probe', () => {
    renderDetails(
      'darwin',
      { ...IOS_SELECTION, state: 'ready', message: 'Ready', devices: [] },
      { ok: false, message: 'serve-sim is unavailable.' }
    )
    expect(container.textContent).toContain('serve-sim is unavailable.')
    const iosRow = container.firstElementChild?.firstElementChild
    expect(iosRow?.querySelector('.text-status-success')).toBeNull()
  })
})
