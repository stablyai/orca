import type { Page } from '@stablyai/playwright-test'
import { getDefaultVoiceControlSettings, getDefaultVoiceSettings } from '../../src/shared/constants'
import type { VoiceSettings } from '../../src/shared/speech-types'
import type { VoiceControlToolActivityEvent } from '../../src/shared/voice-control-types'
import { expect, test } from './helpers/orca-app'

// Live layer opt-in, same gating idiom as staging-skill-sharing.spec.ts.
const RUN_LIVE = process.env.ORCA_E2E_VOICE_LIVE === '1'
const OPENAI_API_KEY = process.env.ORCA_OPENAI_API_KEY?.trim()

if (RUN_LIVE && !OPENAI_API_KEY) {
  throw new Error('ORCA_OPENAI_API_KEY is required for the live voice control journey.')
}

const INDICATOR_TESTID = 'voice-control-indicator'
const START_LABEL = 'Talk to your agents'
const KEY_MISSING_COPY = 'Add an OpenAI API key in Settings > Voice to use full voice control.'

async function enableVoiceControl(page: Page): Promise<void> {
  const settings = await page.evaluate(() => window.api.settings.get())
  // updateSettings replaces `voice` wholesale, so re-spread the persisted object and
  // flip only the control gate.
  const voice: VoiceSettings = {
    ...getDefaultVoiceSettings(),
    ...settings.voice,
    control: { ...getDefaultVoiceControlSettings(), ...settings.voice?.control, enabled: true }
  }
  await page.evaluate(async (nextVoice) => {
    const store = window.__store
    if (!store) {
      throw new Error('Expected the E2E store to be exposed')
    }
    await store.getState().updateSettings({ voice: nextVoice })
  }, voice)
}

async function armKeyMissingError(page: Page): Promise<void> {
  await enableVoiceControl(page)
  const indicator = page.getByTestId(INDICATOR_TESTID)
  await indicator.getByRole('button', { name: START_LABEL }).click()
  await expect(indicator.getByText(KEY_MISSING_COPY)).toBeVisible()
}

test.describe('voice control (gated, hermetic)', () => {
  test('keeps the pill unmounted while the gate is off', async ({ orcaPage }) => {
    await expect(orcaPage.getByTestId(INDICATOR_TESTID)).toHaveCount(0)
  })

  test('shows the key-missing error and dismisses back to idle', async ({ orcaPage }) => {
    await enableVoiceControl(orcaPage)
    const indicator = orcaPage.getByTestId(INDICATOR_TESTID)
    await expect(indicator.getByRole('button', { name: START_LABEL })).toBeVisible()

    // The isolated e2e HOME has no ~/.orca/openai-speech-token.enc, so main classifies
    // the start failure as key-missing.
    await indicator.getByRole('button', { name: START_LABEL }).click()
    await expect(indicator.getByText(KEY_MISSING_COPY)).toBeVisible()
    await expect(indicator.getByRole('button', { name: 'Open Voice settings' })).toBeVisible()
    await expect(indicator.getByRole('button', { name: 'Dismiss' })).toBeVisible()

    // Regression: a failed start used to park the pill in the error state forever.
    await indicator.getByRole('button', { name: 'Dismiss' }).click()
    await expect(indicator.getByRole('button', { name: START_LABEL })).toBeVisible()
  })

  test('Open Voice settings opens the voice pane', async ({ orcaPage }) => {
    await armKeyMissingError(orcaPage)
    const indicator = orcaPage.getByTestId(INDICATOR_TESTID)
    await indicator.getByRole('button', { name: 'Open Voice settings' }).click()

    await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
    const featureTipDialog = orcaPage.getByRole('dialog', { name: 'Voice Dictation is here' })
    if (await featureTipDialog.isVisible().catch(() => false)) {
      await orcaPage.getByRole('button', { name: 'Maybe Later' }).click()
    }
    await expect(
      orcaPage
        .locator('[data-settings-section="voice"]')
        .getByRole('heading', { name: 'Voice', exact: true })
    ).toBeInViewport({ timeout: 10_000 })
  })
})

test.describe('voice control (live OpenAI realtime)', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(
    !RUN_LIVE,
    'Set ORCA_E2E_VOICE_LIVE=1 and ORCA_OPENAI_API_KEY to run the live voice control journey.'
  )
  // Why: CI hosts have no microphone; Chromium's fake device keeps getUserMedia
  // deterministic for the opt-in live run.
  test.use({
    orcaAppExtraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  })

  test('reaches live and routes a spoken question through list_agents', async ({ orcaPage }) => {
    test.setTimeout(5 * 60_000)
    if (!OPENAI_API_KEY) {
      throw new Error('ORCA_OPENAI_API_KEY is required for the live voice control journey.')
    }

    // Same IPC the Voice settings pane uses to persist the OpenAI speech key.
    await orcaPage.evaluate((apiKey) => window.api.speech.saveOpenAiApiKey(apiKey), OPENAI_API_KEY)
    await subscribeToolActivity(orcaPage)

    await enableVoiceControl(orcaPage)
    const indicator = orcaPage.getByTestId(INDICATOR_TESTID)
    await indicator.getByRole('button', { name: START_LABEL }).click()

    await expect
      .poll(async () => (await orcaPage.evaluate(() => window.api.voiceControl.getState())).state, {
        timeout: 120_000,
        message: 'voice control never reached the live state'
      })
      .toBe('live')
    await expect(indicator.getByRole('button', { name: 'Stop voice control' })).toBeVisible()

    // A Playwright run cannot speak into the fake mic, so drive the provider over the
    // build-gated client-event seam instead.
    await orcaPage.waitForFunction(() => Boolean(window.__voiceControlE2E))
    await orcaPage.evaluate(() => {
      window.__voiceControlE2E?.sendClientEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Who is running?' }]
        }
      })
      window.__voiceControlE2E?.sendClientEvent({ type: 'response.create' })
    })

    await expect
      .poll(
        async () =>
          (await readToolActivity(orcaPage)).some((event) => event.tool === 'list_agents'),
        { timeout: 120_000, message: 'list_agents tool activity never arrived' }
      )
      .toBe(true)
  })
})

async function subscribeToolActivity(page: Page): Promise<void> {
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spec-local window scratch space; installed here and read back only by readToolActivity below.
    const scratch = window as unknown as {
      __voiceControlToolEvents?: VoiceControlToolActivityEvent[]
    }
    scratch.__voiceControlToolEvents = []
    window.api.voiceControl.onToolActivity((event) => {
      scratch.__voiceControlToolEvents?.push(event)
    })
  })
}

async function readToolActivity(page: Page): Promise<VoiceControlToolActivityEvent[]> {
  return page.evaluate(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the scratch array installed by subscribeToolActivity above.
    const scratch = window as unknown as {
      __voiceControlToolEvents?: VoiceControlToolActivityEvent[]
    }
    return scratch.__voiceControlToolEvents ?? []
  })
}
