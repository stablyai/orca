import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  claudeTranscriptLines,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test.use({ minimumSeededWorktreeCount: 1 })

test('chat body weight snaps to three distinct steps while headings, bold and code keep their weights', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const visible = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused())
  )
  expect(visible).toBe(false)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-text-weight-${randomUUID()}`
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-text-weight-'))
  const transcriptPath = path.join(scratch, 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({
      sessionId,
      userText: 'Make chat text comfortable to read. 保持正文与粗体清晰可辨。',
      assistantText:
        '# Heading one\n\n## Heading two\n\n### Heading three\n\n#### Heading four\n\n##### Heading five\n\n###### Heading six\n\nRead the message comfortably. **Keep bold text distinct.**\n\n正文清晰易读。**粗体保持醒目。**\n\nInline code: `const weight = 400`\n\n```ts\nconst readable = true\n```'
    })
  )
  try {
    await orcaPage.evaluate(async () => {
      await window.__store!.getState().updateSettings({
        experimentalNativeChat: true,
        uiLanguage: 'en',
        nativeChatAppearance: undefined
      })
    })
    await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
    const chat = orcaPage.locator('[data-native-chat-root="true"]')
    const prose = chat
      .locator('.native-chat-markdown')
      .filter({ hasText: 'Read the message comfortably.' })
    await expect(prose).toBeVisible({ timeout: 30_000 })
    await orcaPage.evaluate(() => document.fonts.ready)
    const composer = chat.getByRole('textbox')
    const expectComposerWeight = async (weight: number, capture?: string): Promise<void> => {
      await expect(composer).toHaveCSS('font-weight', String(weight))
      await composer.fill('')
      const placeholder = composer.locator('p.is-editor-empty[data-placeholder]')
      await expect(placeholder).toHaveAttribute('data-placeholder', /.+/)
      expect(
        await placeholder.evaluate((element) => getComputedStyle(element, '::before').fontWeight)
      ).toBe(String(weight))
      if (capture) {
        await composer.screenshot({ path: testInfo.outputPath(`composer-empty-${capture}.png`) })
      }
      await composer.fill('Draft text follows the message weight.')
      await expect(composer).toHaveText('Draft text follows the message weight.')
      await expect(composer.locator('p')).toHaveCSS('font-weight', String(weight))
      if (capture) {
        await composer.screenshot({ path: testInfo.outputPath(`composer-draft-${capture}.png`) })
      }
      await composer.fill('')
    }
    const expectHeadingWeights = async (): Promise<void> => {
      const headings = prose.getByRole('heading')
      await expect(headings).toHaveCount(6)
      for (const heading of await headings.all()) {
        await expect(heading).toHaveCSS('font-weight', '600')
      }
    }
    const openAppearance = async (): Promise<void> => {
      await orcaPage.evaluate(() => {
        window.__store!.getState().openSettingsPage()
        window.__store!.getState().openSettingsTarget({ pane: 'chat', repoId: null })
      })
    }
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(async (theme) => {
        await window.__store!.getState().updateSettings({ theme })
      }, theme)
      const samples = new Map<number, Buffer>()
      for (const [key, weight, label] of [
        ['Home', 300, 'Light'],
        ['ArrowRight', 400, 'Regular'],
        ['End', 500, 'Medium']
      ] as const) {
        await openAppearance()
        const slider = orcaPage.getByRole('slider', { name: 'Text weight' })
        await expect(slider).toBeVisible()
        await slider.press(key)
        await expect(slider).toHaveAttribute('aria-valuenow', String(weight))
        await expect(slider).toHaveAttribute('aria-valuetext', label)
        await expect(slider).toBeFocused()
        if (weight === 500) {
          await orcaPage
            .locator('#chat-appearance')
            .screenshot({ path: testInfo.outputPath(`settings-${theme}.png`) })
        }
        await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
        await expect(prose).toHaveCSS('font-weight', String(weight))
        await expectComposerWeight(weight, `${theme}-${weight}`)
        await expectHeadingWeights()
        await expect(prose.locator('strong').first()).toHaveCSS('font-weight', '700')
        await expect(prose.locator('code').first()).toHaveCSS('font-weight', '400')
        if (weight !== 400) {
          await openAppearance()
          const matching = orcaPage.getByRole('switch', { name: 'Match terminal interface' })
          await matching.click()
          await expect(matching).toBeChecked()
          await expect(slider).toBeDisabled()
          await expect(slider).toHaveAttribute('aria-valuenow', '400')
          await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
          await expect(prose).toHaveCSS('font-weight', '400')
          await expectComposerWeight(400)
          await expectHeadingWeights()

          await openAppearance()
          await expect(matching).toBeChecked()
          await matching.click()
          await expect(matching).not.toBeChecked()
          await expect(slider).toBeEnabled()
          await expect(slider).toHaveAttribute('aria-valuenow', String(weight))
          await expect(slider).toHaveAttribute('aria-valuetext', label)
          await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
          await expect(prose).toHaveCSS('font-weight', String(weight))
          await expectComposerWeight(weight)
          await expectHeadingWeights()
          await expect(prose.locator('strong').first()).toHaveCSS('font-weight', '700')
          await expect(prose.locator('code').first()).toHaveCSS('font-weight', '400')
        }
        samples.set(
          weight,
          await prose.screenshot({ path: testInfo.outputPath(`prose-${theme}-${weight}.png`) })
        )
        await chat.screenshot({ path: testInfo.outputPath(`chat-${theme}-${weight}.png`) })
      }
      expect(samples.get(300)!.equals(samples.get(400)!)).toBe(false)
      expect(samples.get(400)!.equals(samples.get(500)!)).toBe(false)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
