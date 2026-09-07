import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'

type MeterFixture = {
  level: number
  isSpeaking: boolean
  isClipping: boolean
}

async function setDictationVisualState(
  page: Page,
  state: 'starting' | 'listening' | 'paused' | 'stopping',
  meter: MeterFixture,
  partialTranscript = ''
): Promise<void> {
  await page.evaluate(
    ({ dictationState, transcript }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected the E2E store to be exposed')
      }
      store.setState({
        dictationState,
        partialTranscript: transcript
      })
    },
    { dictationState: state, transcript: partialTranscript }
  )
  await page.waitForFunction(() => Boolean(window.__dictationMeterE2E))
  await page.evaluate((dictationMeter) => {
    window.__dictationMeterE2E?.publish(dictationMeter)
  }, meter)
}

async function pauseForRecordedProof(page: Page): Promise<void> {
  if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
    await page.waitForTimeout(700)
  }
}

test('dictation grapes react across the visible recording lifecycle', async ({ orcaPage }) => {
  const quiet = { level: 0, isSpeaking: false, isClipping: false }
  await setDictationVisualState(orcaPage, 'starting', quiet)

  const startingIndicator = orcaPage.getByTestId('dictation-indicator')
  await expect(startingIndicator.getByRole('status')).toHaveText('Starting mic…')
  await expect(startingIndicator.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect(startingIndicator.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(startingIndicator.getByRole('button', { name: 'Clear' })).toBeVisible()

  await setDictationVisualState(orcaPage, 'listening', quiet)

  const indicator = orcaPage.getByTestId('dictation-indicator')
  const status = indicator.getByRole('status')
  await expect(indicator).toBeVisible()
  await expect(status).toHaveText('Listening')
  await expect(indicator.getByTestId('dictation-grapes').locator('span')).toHaveCount(9)
  await expect(indicator.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(indicator.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect(indicator.getByRole('button', { name: 'Clear' })).toBeVisible()
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await expect(indicator.getByTestId('dictation-grapes').locator('span').first()).toHaveCSS(
    'transition-property',
    'none'
  )
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  await pauseForRecordedProof(orcaPage)

  const speaking = {
    level: 0.76,
    isSpeaking: true,
    isClipping: false
  }
  await setDictationVisualState(orcaPage, 'listening', speaking)
  await expect(indicator.getByText('Speaking')).toBeVisible()
  await expect(status).toHaveText('Listening')
  await pauseForRecordedProof(orcaPage)

  const clipping = { ...speaking, level: 1, isClipping: true }
  await setDictationVisualState(orcaPage, 'listening', clipping)
  await expect(status).toHaveText('Too loud')
  await expect(indicator).toHaveClass(/text-destructive/)
  await pauseForRecordedProof(orcaPage)

  await setDictationVisualState(
    orcaPage,
    'listening',
    speaking,
    'The visualizer follows every word without covering the workspace.'
  )
  await expect(
    orcaPage.getByText('The visualizer follows every word without covering the workspace.')
  ).toBeVisible()
  await expect(status).toHaveText('Listening')
  await pauseForRecordedProof(orcaPage)

  await setDictationVisualState(orcaPage, 'paused', quiet)
  await expect(status).toHaveText('Paused')
  await expect(indicator.getByRole('button', { name: 'Resume' })).toBeVisible()
  await expect(indicator.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(indicator.getByRole('button', { name: 'Clear' })).toBeVisible()
  await pauseForRecordedProof(orcaPage)

  await setDictationVisualState(orcaPage, 'stopping', quiet)
  await expect(status).toHaveText('Processing…')
  await expect(indicator.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await pauseForRecordedProof(orcaPage)
})
