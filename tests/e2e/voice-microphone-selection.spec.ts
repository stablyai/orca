import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type FakeMicrophoneDevice = {
  deviceId: string
  label: string
}

type FakeMicrophoneState = {
  devices: FakeMicrophoneDevice[]
  dispatchDeviceChange: () => void
}

async function installFakeMicrophoneDevices(
  page: Parameters<typeof waitForSessionReady>[0],
  devices: FakeMicrophoneDevice[]
): Promise<void> {
  await page.addInitScript((initialDevices) => {
    const listeners = new Set<EventListener>()
    const state: FakeMicrophoneState = {
      devices: initialDevices,
      dispatchDeviceChange: () => {
        for (const listener of listeners) {
          listener(new Event('devicechange'))
        }
      }
    }
    const mediaDevices = {
      enumerateDevices: async () =>
        state.devices.map((device) => ({
          ...device,
          kind: 'audioinput' as const,
          groupId: ''
        })),
      getUserMedia: async () => {
        throw new DOMException('E2E microphone access is not used by this spec', 'NotAllowedError')
      },
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'devicechange') {
          listeners.add(listener)
        }
      },
      removeEventListener: (type: string, listener: EventListener) => {
        if (type === 'devicechange') {
          listeners.delete(listener)
        }
      }
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices
    })
    ;(
      window as Window & { __orcaE2EFakeMicrophone?: FakeMicrophoneState }
    ).__orcaE2EFakeMicrophone = state
  }, devices)
}

async function prepareVoiceSettings(
  page: Parameters<typeof waitForSessionReady>[0],
  microphoneDeviceId: string | null,
  microphoneDeviceLabel: string | null
): Promise<void> {
  await page.evaluate(
    async ({ microphoneDeviceId, microphoneDeviceLabel }) => {
      const store = window.__store
      const settings = await window.api.settings.get()
      if (!store || !settings.voice) {
        throw new Error('Voice settings are not available')
      }
      await store.getState().updateSettings({
        uiLanguage: 'en',
        voice: {
          ...settings.voice,
          enabled: true,
          microphoneDeviceId,
          microphoneDeviceLabel
        }
      })
      store.getState().openSettingsTarget({ pane: 'voice', repoId: null })
      store.getState().openSettingsPage()
    },
    { microphoneDeviceId, microphoneDeviceLabel }
  )
  await expect(page.getByPlaceholder('Search settings')).toBeVisible()
  const featureTipDialog = page.getByRole('dialog', { name: 'Voice Dictation is here' })
  if (await featureTipDialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Maybe Later' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Voice', exact: true })).toBeVisible()
}

async function readMicrophoneSettings(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<{ deviceId: string | null; label: string | null }> {
  return page.evaluate(async () => {
    const voice = (await window.api.settings.get()).voice
    return {
      deviceId: voice?.microphoneDeviceId ?? null,
      label: voice?.microphoneDeviceLabel ?? null
    }
  })
}

test.describe('Voice microphone selection', () => {
  test('lists devices, persists a selected microphone, and restores it', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await installFakeMicrophoneDevices(orcaPage, [
      { deviceId: 'built-in', label: 'Built-in Microphone' },
      { deviceId: 'usb-mic', label: 'USB Microphone' }
    ])
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForSessionReady(orcaPage)
    await prepareVoiceSettings(orcaPage, null, null)

    const microphone = orcaPage.getByRole('combobox', { name: 'Microphone' })
    await expect(microphone).toHaveText('System default')
    // Settings can still be animating; keyboard activation does not depend on its position.
    await microphone.press('Space')
    await expect(orcaPage.getByRole('option', { name: 'USB Microphone' })).toBeVisible()
    // Keyboard selection bypasses the transient pointer stability gate in CI.
    await orcaPage.getByRole('option', { name: 'USB Microphone' }).press('Enter')

    await expect
      .poll(() => readMicrophoneSettings(orcaPage), {
        message: 'selected microphone did not persist'
      })
      .toEqual({ deviceId: 'usb-mic', label: 'USB Microphone' })

    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForSessionReady(orcaPage)
    await prepareVoiceSettings(orcaPage, 'usb-mic', 'USB Microphone')
    await expect(orcaPage.getByRole('combobox', { name: 'Microphone' })).toHaveText(
      'USB Microphone'
    )
  })

  test('marks an unplugged device unavailable and follows a relabeled device', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await installFakeMicrophoneDevices(orcaPage, [
      { deviceId: 'built-in', label: 'Built-in Microphone' }
    ])
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForSessionReady(orcaPage)
    await prepareVoiceSettings(orcaPage, 'stale-airpods-id', 'AirPods')

    const microphone = orcaPage.getByRole('combobox', { name: 'Microphone' })
    await microphone.press('Space')
    await expect(orcaPage.getByRole('option', { name: 'AirPods (unavailable)' })).toBeVisible()
    await orcaPage.keyboard.press('Escape')

    await orcaPage.evaluate(() => {
      const state = (window as Window & { __orcaE2EFakeMicrophone?: FakeMicrophoneState })
        .__orcaE2EFakeMicrophone
      if (!state) {
        throw new Error('Fake microphone state is not available')
      }
      state.devices = [
        { deviceId: 'built-in', label: 'Built-in Microphone' },
        { deviceId: 'fresh-airpods-id', label: 'AirPods' }
      ]
      state.dispatchDeviceChange()
    })

    // Why: devicechange can leave Radix's listbox open and aria-hide the
    // trigger, so getByRole('combobox') finds nothing. The live option is
    // the stable handle; open the named trigger only if the list is closed.
    const airpodsOption = orcaPage.getByRole('option', { name: 'AirPods', exact: true })
    await expect(async () => {
      if (!(await airpodsOption.isVisible().catch(() => false))) {
        const trigger = orcaPage.getByRole('combobox', { name: 'Microphone' })
        await expect(trigger).toHaveText('AirPods', { timeout: 1_000 })
        await trigger.press('Space')
      }
      await expect(airpodsOption).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 10_000 })
    await expect(orcaPage.getByRole('option', { name: 'AirPods (unavailable)' })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(readMicrophoneSettings(orcaPage)).resolves.toEqual({
      deviceId: 'stale-airpods-id',
      label: 'AirPods'
    })
  })
})
