import type { Page } from '@stablyai/playwright-test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

const CODEX_READY_RE = /Ask Codex|OpenAI|Type your question|press enter/i
const CODEX_TRUST_PROMPT_RE = /Do you trust|trust this folder|Trust this/i
const CODEX_UPDATE_PROMPT_RE = /update available|install update|Skip for now/i
const ARTIFACT_DIR = path.join(process.cwd(), '.tmp', 'codex-scroll-repro')

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function dismissCodexPromptsIfPresent(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const content = await getTerminalContent(page, 20_000)
    if (CODEX_READY_RE.test(content) && !CODEX_TRUST_PROMPT_RE.test(content)) {
      return
    }
    if (CODEX_TRUST_PROMPT_RE.test(content)) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
      continue
    }
    if (CODEX_UPDATE_PROMPT_RE.test(content)) {
      await page.keyboard.type('3')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
      continue
    }
    await page.waitForTimeout(250)
  }
}

async function focusPaneByIndex(page: Page, paneIndex: number): Promise<void> {
  await page.evaluate((paneIndex) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getPanes?.()[paneIndex] ?? null
    if (!manager || !pane) {
      throw new Error(`Terminal pane ${paneIndex} is unavailable`)
    }
    manager.setActivePane(pane.id, { focus: true })
  }, paneIndex)
}

async function readActiveTerminalScrollState(page: Page): Promise<{
  baseY: number
  bufferType: string
  leafId: string | null
  paneId: number
  viewportY: number
}> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    const buffer = pane.terminal.buffer.active
    return {
      baseY: buffer.baseY,
      bufferType: buffer.type,
      leafId: pane.leafId ?? null,
      paneId: pane.id,
      viewportY: buffer.viewportY
    }
  })
}

async function readTerminalScrollStateForPaneIndex(
  page: Page,
  paneIndex: number
): Promise<{
  baseY: number
  bufferType: string
  leafId: string | null
  paneId: number
  viewportY: number
}> {
  return page.evaluate((paneIndex) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getPanes?.()[paneIndex] ?? null
    if (!pane) {
      throw new Error(`Terminal pane ${paneIndex} unavailable`)
    }
    const buffer = pane.terminal.buffer.active
    return {
      baseY: buffer.baseY,
      bufferType: buffer.type,
      leafId: pane.leafId ?? null,
      paneId: pane.id,
      viewportY: buffer.viewportY
    }
  }, paneIndex)
}

async function sampleTerminalScrollStateFramesOnActiveWorktree(
  page: Page,
  worktreeId: string,
  paneIndex: number
): Promise<
  {
    frame: number
    scrollState: {
      baseY: number
      bufferType: string
      leafId: string | null
      paneId: number
      viewportY: number
    } | null
  }[]
> {
  return page.evaluate(
    ({ paneIndex, worktreeId }) =>
      new Promise((resolve) => {
        const samples: {
          frame: number
          scrollState: {
            baseY: number
            bufferType: string
            leafId: string | null
            paneId: number
            viewportY: number
          } | null
        }[] = []
        let started = false
        const sample = (): void => {
          const state = window.__store?.getState()
          if (state?.activeWorktreeId === worktreeId) {
            started = true
            const tabId =
              state.activeTabType === 'terminal'
                ? state.activeTabId
                : (state.activeTabIdByWorktree?.[worktreeId] ?? null)
            const manager = tabId ? window.__paneManagers?.get(tabId) : null
            const pane = manager?.getPanes?.()[paneIndex] ?? null
            if (pane) {
              const buffer = pane.terminal.buffer.active
              samples.push({
                frame: samples.length,
                scrollState: {
                  baseY: buffer.baseY,
                  bufferType: buffer.type,
                  leafId: pane.leafId ?? null,
                  paneId: pane.id,
                  viewportY: buffer.viewportY
                }
              })
            } else {
              samples.push({ frame: samples.length, scrollState: null })
            }
          }
          if (started && samples.length >= 30) {
            resolve(samples)
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
    { paneIndex, worktreeId }
  )
}

async function scrollCodexViewportJustAboveBottom(page: Page): Promise<{
  baseY: number
  bufferType: string
  leafId: string | null
  paneId: number
  viewportY: number
}> {
  const target = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error('Active terminal pane unavailable')
    }
    pane.terminal.focus()
    pane.terminal.scrollToBottom()
    const wheelTarget =
      pane.container.querySelector<HTMLElement>('.xterm-viewport') ??
      pane.container.querySelector<HTMLElement>('.xterm') ??
      pane.container.querySelector<HTMLElement>('.xterm-screen')
    if (!wheelTarget) {
      throw new Error('Active terminal wheel target unavailable')
    }
    const rect = wheelTarget.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    }
  })
  const isAboveBottom = async (): Promise<boolean> => {
    const state = await readActiveTerminalScrollState(page)
    return state.bufferType === 'normal' && state.viewportY > 0 && state.viewportY < state.baseY
  }
  const attempts: (() => Promise<void>)[] = [
    async () => {
      await page.mouse.move(target.x, target.y)
      await page.mouse.wheel(0, -1200)
    },
    async () => {
      await page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        if (!pane) {
          throw new Error('Active terminal pane unavailable')
        }
        const wheelTargets = [
          pane.container.querySelector<HTMLElement>('.xterm'),
          pane.container.querySelector<HTMLElement>('.xterm-viewport'),
          pane.container.querySelector<HTMLElement>('.xterm-screen')
        ].filter((candidate): candidate is HTMLElement => Boolean(candidate))
        for (const wheelTarget of wheelTargets) {
          wheelTarget.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL,
              deltaY: -1200
            })
          )
        }
      })
    },
    async () => {
      await page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        const viewport = pane?.container.querySelector<HTMLElement>('.xterm-viewport')
        if (!viewport) {
          throw new Error('Active terminal viewport unavailable')
        }
        viewport.scrollTop = Math.max(0, viewport.scrollTop - 1200)
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
      })
    },
    async () => {
      await page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        const tabId =
          state?.activeTabType === 'terminal'
            ? state.activeTabId
            : worktreeId
              ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
              : null
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        if (!pane) {
          throw new Error('Active terminal pane unavailable')
        }
        const targetLine = Math.max(1, pane.terminal.buffer.active.baseY - 20)
        pane.terminal.scrollToLine(targetLine)
      })
    }
  ]
  for (const attempt of attempts) {
    await attempt()
    await page.waitForTimeout(100)
    if (await isAboveBottom()) {
      break
    }
  }
  await expect
    .poll(
      () =>
        readActiveTerminalScrollState(page).then(
          (state) =>
            state.bufferType === 'normal' && state.viewportY > 0 && state.viewportY < state.baseY
        ),
      {
        timeout: 5_000,
        message: 'Codex viewport did not settle above bottom before switching'
      }
    )
    .toBe(true)
  return readActiveTerminalScrollState(page)
}

async function waitForCodexReady(page: Page): Promise<void> {
  try {
    await expect
      .poll(
        () => getTerminalContent(page, 20_000).then((content) => CODEX_READY_RE.test(content)),
        {
          timeout: 60_000,
          message: 'Codex TUI did not render'
        }
      )
      .toBe(true)
  } catch (error) {
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    writeFileSync(
      path.join(ARTIFACT_DIR, 'codex-launch-terminal.txt'),
      await getTerminalContent(page, 20_000)
    )
    throw error
  }
}

async function waitForTerminalScrollback(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => readActiveTerminalScrollState(page).then((state) => state.baseY), {
        timeout: 180_000,
        message: 'Codex did not produce terminal scrollback'
      })
      .toBeGreaterThan(40)
  } catch (error) {
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    writeFileSync(
      path.join(ARTIFACT_DIR, 'codex-no-scrollback-terminal.txt'),
      await getTerminalContent(page, 40_000)
    )
    throw error
  }
}

async function waitForCodexResponseLine(
  page: Page,
  marker: string,
  lineNumber: number
): Promise<void> {
  await expect
    .poll(() => getTerminalContent(page, 40_000), {
      timeout: 180_000,
      message: 'Codex did not finish the generated scrollback response'
    })
    .toContain(`${marker}_VISIBLE_LINE_${lineNumber}`)
}

async function waitForStableActiveTerminalScrollback(page: Page): Promise<void> {
  let previousBaseY: number | null = null
  let stableSamples = 0
  await expect
    .poll(
      async () => {
        const { baseY } = await readActiveTerminalScrollState(page)
        if (baseY === previousBaseY) {
          stableSamples += 1
        } else {
          previousBaseY = baseY
          stableSamples = 0
        }
        return stableSamples >= 3
      },
      {
        timeout: 15_000,
        message: 'Codex scrollback did not settle before switching'
      }
    )
    .toBe(true)
}

test.describe('Codex TUI scroll position repro', () => {
  test('keeps real Codex TUI scrollback position across worktree switches', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    test.skip(process.env.ORCA_E2E_REAL_CODEX !== '1', 'requires real local Codex CLI')
    test.skip(process.platform === 'win32', 'local Codex command is POSIX-shell oriented')

    await waitForSessionReady(orcaPage)
    const firstWorktreeId = await waitForActiveWorktree(orcaPage)
    const secondWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'Codex scroll repro needs a second seeded worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)

    const marker = `CODEX_SCROLL_REPRO_${Date.now()}`
    const prompt = [
      'Do not run commands.',
      'Reply with exactly 360 separate short lines.',
      `Each line must be in the form "${marker}_VISIBLE_LINE_N" where N counts up from 0.`,
      'Do not use markdown bullets or code fences.'
    ].join(' ')
    const codexCommand = [
      'codex',
      '--no-alt-screen',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '-C',
      shellQuote(process.cwd()),
      shellQuote(prompt)
    ].join(' ')
    await sendToTerminal(orcaPage, ptyId, `${codexCommand}\r`)
    await dismissCodexPromptsIfPresent(orcaPage)
    await waitForCodexReady(orcaPage)
    await waitForTerminalScrollback(orcaPage)
    await waitForCodexResponseLine(orcaPage, marker, 359)
    await waitForStableActiveTerminalScrollback(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const state = window.__store?.getState()
            const tabId = state?.activeTabId
            return tabId ? (window.__paneManagers?.get(tabId)?.getPanes?.().length ?? 0) : 0
          }),
        { timeout: 10_000 }
      )
      .toBe(2)
    await focusPaneByIndex(orcaPage, 0)

    const beforeSwitch = await scrollCodexViewportJustAboveBottom(orcaPage)
    testInfo.annotations.push({
      type: 'codex-scroll-before-switch',
      description: JSON.stringify(beforeSwitch)
    })
    expect(beforeSwitch.baseY).toBeGreaterThan(20)
    expect(beforeSwitch.viewportY).toBeGreaterThan(0)
    expect(beforeSwitch.viewportY).toBeLessThan(beforeSwitch.baseY)

    await orcaPage.getByRole('option', { name: /e2e-secondary/ }).click()
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(secondWorktreeId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.waitForTimeout(500)

    const returnFrameSamplesPromise = sampleTerminalScrollStateFramesOnActiveWorktree(
      orcaPage,
      firstWorktreeId,
      0
    )
    await orcaPage.getByRole('option', { name: /main/ }).first().click()
    await expect
      .poll(() => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(firstWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const returnFrameSamples = await returnFrameSamplesPromise

    const afterSwitch = await readTerminalScrollStateForPaneIndex(orcaPage, 0)
    testInfo.annotations.push({
      type: 'codex-scroll-after-switch',
      description: JSON.stringify(afterSwitch)
    })
    const beforeBottomOffset = beforeSwitch.baseY - beforeSwitch.viewportY
    const afterBottomOffset = afterSwitch.baseY - afterSwitch.viewportY
    expect(afterSwitch.viewportY).toBeGreaterThan(0)
    // xterm can reflow several rows when the split pane is hidden and refit;
    // the regression is the viewport teleporting to the top.
    expect(Math.abs(afterBottomOffset - beforeBottomOffset)).toBeLessThanOrEqual(10)
    expect(
      returnFrameSamples.filter(
        (sample) => sample.scrollState?.baseY && sample.scrollState.viewportY === 0
      )
    ).toEqual([])
  })
})
