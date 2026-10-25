import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test('Russian picker opens a localized chat while preserving the provider transcript', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Renderer store unavailable')
    }
    await state.updateSettingsOrThrow({ uiLanguage: 'en' })
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
    state.openSettingsPage()
  })
  await orcaPage.getByRole('combobox', { name: 'Language', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Русский', exact: true }).click()
  await expect(orcaPage.getByRole('combobox', { name: 'Язык', exact: true })).toHaveText('Русский')
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.api.settings.get().then((settings) => settings.uiLanguage))
    )
    .toBe('ru')
  await orcaPage.screenshot({ path: testInfo.outputPath('russian-language-picker.png') })
  await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const sessionId = `e2e-russian-${randomUUID()}`
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-russian-'))
  registerPostElectronShutdownCleanup(() => rm(directory, { recursive: true, force: true }))
  const transcriptPath = path.join(directory, `${sessionId}.jsonl`)
  await writeFile(
    transcriptPath,
    claudeTranscriptLines({
      sessionId,
      userText: 'Проверь изменения в проекте.',
      assistantText: 'Provider wording stays in its original language.'
    })
  )
  await enableNativeChatSetting(orcaPage)
  await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
  await toggleTerminalTabToChatView(orcaPage, {
    tabId: descriptor.paneKey.split(':')[0],
    worktreeId: descriptor.worktreeId
  })
  await expect(orcaPage.locator('[data-native-chat-window]')).toBeVisible()
  await expect(
    orcaPage.getByText('Provider wording stays in its original language.', { exact: true })
  ).toBeVisible()
  const composer = orcaPage.getByRole('textbox', {
    name: 'Задайте вопрос; @ — файлы, / — команды',
    exact: true
  })
  await expect(composer).toBeVisible()
  await composer.fill('Затем проверь тесты.')
  await expect(composer).toHaveText('Затем проверь тесты.')
  await orcaPage.screenshot({ path: testInfo.outputPath('russian-conversation.png') })
})
