import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  claudeTranscriptLines,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

const SHOTS_DIR = process.env.ORCA_CHAT_GALLERY_SHOTS_DIR
const sourceImage = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'site',
  'public',
  'docs',
  'ways-to-run-run-on.png'
)
const SHOTS = ['First shot', 'Second shot', 'Third shot'] as const

/** Long enough that the first turn's row leaves the virtualized window when the last is shown. */
const FILLER = Array.from({ length: 120 }, (_, line) => `Filler paragraph ${line + 1}.`).join(
  '\n\n'
)

function transcript(sessionId: string, imagePaths: readonly string[]): string {
  return imagePaths
    .flatMap((imagePath, index) => [
      claudeTranscriptLines({
        sessionId,
        messageIdPrefix: `${sessionId}-shot-${index}`,
        userText: `Take screenshot ${index + 1}.`,
        assistantText: `Screenshot ${index + 1}:\n\n![${SHOTS[index]}](${imagePath})`
      }),
      index < imagePaths.length - 1
        ? claudeTranscriptLines({
            sessionId,
            messageIdPrefix: `${sessionId}-filler-${index}`,
            userText: 'Keep going.',
            assistantText: FILLER
          })
        : ''
    ])
    .join('')
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR) {
    mkdirSync(SHOTS_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) })
  }
}

async function expectShowing(dialog: Locator, title: string, position: string): Promise<void> {
  await expect(dialog.getByRole('img', { name: title })).toBeVisible()
  await expect(dialog.locator('[data-pan-zoom-position]')).toHaveText(position)
}

test("steps through a chat's images from the enlarged preview, including unmounted rows", async ({
  orcaPage,
  testRepoPath
}) => {
  const sessionId = `e2e-image-gallery-${randomUUID()}`
  const imagePaths = SHOTS.map((_, index) =>
    path.join(testRepoPath, `gallery-shot-${index + 1}-${randomUUID()}.png`)
  )
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-image-gallery-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  for (const imagePath of imagePaths) {
    copyFileSync(sourceImage, imagePath)
  }

  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    writeFileSync(transcriptPath, transcript(sessionId, imagePaths))
    await seedClaudeProviderSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

    const chat = orcaPage.locator('[data-native-chat-root="true"]')
    const lastThumbnail = chat.locator('button:has(img[alt="Third shot"])')
    await expect(lastThumbnail).toBeVisible({ timeout: 30_000 })
    // The virtualizer has not mounted the first turn, so only transcript data can reach it.
    await expect(chat.locator('img[alt="First shot"]')).toHaveCount(0)

    await lastThumbnail.click()
    const dialog = orcaPage.locator('[role="dialog"][data-native-chat-image-gallery]')
    const previous = dialog.locator('[data-pan-zoom-navigation="previous"]')
    const next = dialog.locator('[data-pan-zoom-navigation="next"]')
    await expectShowing(dialog, 'Third shot', '3 / 3')
    await expect(next).toBeDisabled()
    await expect(previous).toBeEnabled()
    await shot(orcaPage, '1-opened-last')

    await orcaPage.keyboard.press('ArrowLeft')
    await expectShowing(dialog, 'Second shot', '2 / 3')
    await previous.click()
    await expectShowing(dialog, 'First shot', '1 / 3')
    await expect(previous).toBeDisabled()
    await expect(next).toBeEnabled()
    await shot(orcaPage, '2-stepped-to-first')

    await orcaPage.keyboard.press('ArrowRight')
    await expectShowing(dialog, 'Second shot', '2 / 3')

    await orcaPage.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(lastThumbnail).toBeFocused()
  } finally {
    for (const imagePath of imagePaths) {
      rmSync(imagePath, { force: true })
    }
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
