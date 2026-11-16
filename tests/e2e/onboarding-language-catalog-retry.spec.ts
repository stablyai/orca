import { test, expect } from './helpers/orca-app'

test.use({ dismissOnboarding: false, seedTestRepo: false })

test('recovers rejected language catalogs without reloading', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const startupLanguage = await orcaPage.evaluate(async () => {
    const detection = await window.api.app.getSystemLanguageDetection?.([navigator.language])
    return detection?.locale
  })
  const candidates = (
    [
      { locale: 'fr', name: 'Français', title: 'Langue d’affichage' },
      { locale: 'ja', name: '日本語', title: '表示言語' },
      { locale: 'es', name: 'Español', title: 'Idioma de la interfaz' }
    ] as const
  ).filter((candidate) => candidate.locale !== startupLanguage)
  const [first, second] = candidates
  if (!first || !second) {
    throw new Error('Two unloaded languages are required')
  }
  await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    const settings = await window.api.settings.get()
    if (!settings.telemetry) {
      throw new Error('Telemetry settings unavailable')
    }
    await store.getState().updateSettingsOrThrow({
      uiLanguage: 'en',
      telemetry: { ...settings.telemetry, onboardingLanguageCohort: 'control' }
    })
  })
  const language = first.locale
  const catalogPattern = new RegExp(`/${language}-[^/]+\\.(?:json|js)(?:\\?|$)`)
  await electronApp.evaluate(({ session }, selectedLanguage) => {
    const pattern = new RegExp(`/${selectedLanguage}-[^/]+\\.(?:json|js)(?:\\?|$)`)
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: pattern.test(details.url) })
    })
  }, language)
  const rejected = orcaPage.waitForEvent('requestfailed', {
    predicate: (request) => catalogPattern.test(request.url())
  })
  const timeOrigin = await orcaPage.evaluate(() => performance.timeOrigin)
  await orcaPage.evaluate(async (selectedLanguage) => {
    const store = window.__store
    if (!store) {
      throw new Error('Renderer store unavailable')
    }
    await store.getState().updateSettingsOrThrow({
      uiLanguage: selectedLanguage
    })
  }, language)
  const failedRequest = await rejected
  await orcaPage.getByRole('button', { name: 'Switch language' }).click()
  await expect(orcaPage.getByRole('alert')).toContainText('Could not load this language')
  await orcaPage.screenshot({ path: testInfo.outputPath('catalog-request-rejected.png') })

  await electronApp.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(null)
  })
  expect(
    await orcaPage.evaluate(async (url) => (await fetch(url)).status, failedRequest.url())
  ).toBe(200)
  await orcaPage.getByRole('button', { name: 'Retry', exact: true }).click()

  await expect(orcaPage.getByRole('radio', { name: first.name, exact: true })).toBeChecked()
  await expect(orcaPage.getByRole('radiogroup', { name: first.title, exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.settings.get().then((s) => s.uiLanguage)))
    .toBe(language)
  expect(await orcaPage.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
  await orcaPage.screenshot({ path: testInfo.outputPath('catalog-retry-recovered.png') })

  const nextLanguage = second.locale
  const nextName = second.name
  const previousName = first.name
  const nextPattern = new RegExp(`/${nextLanguage}-[^/]+\\.(?:json|js)(?:\\?|$)`)
  await electronApp.evaluate(({ session }, selectedLanguage) => {
    const pattern = new RegExp(`/${selectedLanguage}-[^/]+\\.(?:json|js)(?:\\?|$)`)
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: pattern.test(details.url) })
    })
  }, nextLanguage)
  const nextRejected = orcaPage.waitForEvent('requestfailed', {
    predicate: (request) => nextPattern.test(request.url())
  })
  await orcaPage.getByRole('radio', { name: nextName, exact: true }).click()
  await nextRejected
  await expect(orcaPage.getByRole('alert')).toBeVisible()
  await expect(orcaPage.getByRole('radio', { name: previousName, exact: true })).toBeChecked()
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.settings.get().then((s) => s.uiLanguage)))
    .toBe(language)

  await electronApp.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(null)
  })
  await orcaPage.getByRole('alert').getByRole('button').click()
  await expect(orcaPage.getByRole('radio', { name: nextName, exact: true })).toBeChecked()
  await expect(
    orcaPage.getByRole('radiogroup', {
      name: second.title,
      exact: true
    })
  ).toBeVisible()
  await expect(orcaPage.getByRole('alert')).toHaveCount(0)
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.settings.get().then((s) => s.uiLanguage)))
    .toBe(nextLanguage)
  expect(await orcaPage.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
})
