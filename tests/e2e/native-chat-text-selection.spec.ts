import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

test.use({ minimumSeededWorktreeCount: 1 })

function selectedTextContrast(screenshot: Buffer): {
  background: string
  foreground: string
  contrast: number
} {
  const png = PNG.sync.read(screenshot)
  const colors = new Map<string, { count: number; luminance: number }>()
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const rgb = [png.data[offset] ?? 0, png.data[offset + 1] ?? 0, png.data[offset + 2] ?? 0]
    const color = rgb.join(',')
    const existing = colors.get(color)
    if (existing) {
      existing.count += 1
      continue
    }
    const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    colors.set(color, { count: 1, luminance: r * 0.2126 + g * 0.7152 + b * 0.0722 })
  }
  const [background] = [...colors].sort((a, b) => b[1].count - a[1].count)
  if (!background) {
    throw new Error('Selection screenshot is empty')
  }
  // Solid glyph interiors recur; ignore rare raster-edge pixels.
  let foreground = background[0]
  let contrast = 1
  for (const [color, { count, luminance }] of colors) {
    if (count < 20) {
      continue
    }
    const candidate =
      (Math.max(luminance, background[1].luminance) + 0.05) /
      (Math.min(luminance, background[1].luminance) + 0.05)
    if (candidate > contrast) {
      foreground = color
      contrast = candidate
    }
  }
  return { background: background[0], foreground, contrast }
}

for (const theme of ['light', 'dark'] as const) {
  test(`native chat selected text is readable in ${theme} appearance`, async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-selection-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-chat-selection-'))
    registerPostElectronShutdownCleanup(async () =>
      rmSync(scratchDir, { recursive: true, force: true })
    )
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    const messages = [
      { role: 'user', text: 'Please select these words to copy part of my message.' },
      { role: 'assistant', text: 'You can select **these words** to copy part of my reply.' }
    ]
    writeFileSync(
      transcriptPath,
      `${messages
        .map(({ role, text }, index) =>
          JSON.stringify({
            sessionId,
            uuid: `${sessionId}-${role}`,
            timestamp: new Date(Date.now() + index * 1_000).toISOString(),
            type: role,
            message: { role, content: [{ type: 'text', text }] }
          })
        )
        .join('\n')}\n`
    )

    await orcaPage.evaluate(
      async ({ paneKey, worktreeId, sessionId, transcriptPath, tabId, theme }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        await store.getState().updateSettings({ experimentalNativeChat: true, theme })
        const state = store.getState()
        state.setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'chat selection probe', agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId },
          { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
        )
        const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
        )
        if (!tab) {
          throw new Error('Terminal tab unavailable')
        }
        state.toggleTabViewMode(tab.id)
      },
      { ...descriptor, sessionId, transcriptPath, tabId, theme }
    )

    await expect(orcaPage.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
    const transcript = orcaPage.locator('[data-native-chat-root="true"]')
    for (const { role } of messages) {
      const paragraph = transcript.locator('p').filter({
        hasText: role === 'user' ? 'Please select these words' : 'You can select these words'
      })
      await expect(paragraph).toBeVisible({ timeout: 30_000 })
      await orcaPage.evaluate(() => window.getSelection()?.removeAllRanges())
      await paragraph.hover()
      const box = await paragraph.boundingBox()
      if (!box) {
        throw new Error('Message paragraph has no bounds')
      }
      await orcaPage.mouse.move(box.x + 1, box.y + box.height / 2)
      await orcaPage.mouse.down()
      await orcaPage.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 20 })
      await orcaPage.mouse.up()
      await expect
        .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString().trim()))
        .toBe(await paragraph.innerText())

      const clip = await orcaPage.evaluate(() => {
        const selection = window.getSelection()
        if (!selection?.rangeCount) {
          throw new Error('Message selection unavailable')
        }
        const { x, y, width, height } = selection.getRangeAt(0).getBoundingClientRect()
        return { x: x + 2, y, width: width - 4, height }
      })

      const selectedPath = testInfo.outputPath(`${theme}-${role}-selected.png`)
      const selected = await orcaPage.screenshot({
        path: selectedPath,
        clip,
        animations: 'disabled'
      })
      await testInfo.attach(`${theme}-${role}-selected`, {
        path: selectedPath,
        contentType: 'image/png'
      })
      const appPath = testInfo.outputPath(`${theme}-${role}-app.png`)
      await orcaPage.screenshot({ path: appPath, animations: 'disabled' })
      for (const emphasis of await paragraph.locator('strong').all()) {
        const emphasisClip = await emphasis.evaluate((element) => {
          const range = document.createRange()
          range.selectNodeContents(element)
          const { x, y, width, height } = range.getBoundingClientRect()
          return { x: x + 2, y, width: width - 4, height }
        })
        const emphasisPaint = selectedTextContrast(
          await orcaPage.screenshot({
            clip: emphasisClip,
            animations: 'disabled'
          })
        )
        expect
          .soft(emphasisPaint.contrast, `${role} selected bold text contrast`)
          .toBeGreaterThanOrEqual(4.5)
      }
      await orcaPage.evaluate(() => window.getSelection()?.removeAllRanges())
      const unselected = await orcaPage.screenshot({ clip, animations: 'disabled' })
      const diff = compareTerminalScreenshots(unselected, selected)
      const paint = selectedTextContrast(selected)
      const appearance = await paragraph.evaluate((element) => {
        const style = getComputedStyle(element)
        return { colorScheme: style.colorScheme, fontSize: style.fontSize }
      })
      console.log(
        JSON.stringify({ theme, ...appearance, role, paint, diff, selectedPath, appPath })
      )
      expect.soft(paint.contrast, `${role} selected text contrast`).toBeGreaterThanOrEqual(4.5)
      expect.soft(diff.diffRatio, `${role} selected pixels visibly change`).toBeGreaterThan(0.15)
    }
  })
}
