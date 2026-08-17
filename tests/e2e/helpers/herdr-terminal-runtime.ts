import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal } from './orca-restart'
import { ensureTerminalVisible } from './store'
import {
  execInTerminal,
  focusActiveTerminalInput,
  getTerminalContent,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForPaneCount,
  waitForPaneIdentitySnapshot,
  waitForTerminalOutput
} from './terminal'
import { SORTABLE_TAB } from './terminal-tab-menu'
import { splitMarkerEchoCommand } from '../terminal-marker-echo-command'
export type HerdrRuntimeSelection = {
  binaryPath?: string
}

export function resolvePinnedHerdrBinary(): string | null {
  if (process.platform === 'win32') {
    return null
  }
  const explicit = process.env.ORCA_HERDR_TEST_BINARY?.trim()
  if (explicit && existsSync(explicit)) {
    return explicit
  }
  try {
    const script = join(process.cwd(), 'config', 'scripts', 'download-herdr-release.mjs')
    const resolved = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 60_000
    }).trim()
    if (resolved && existsSync(resolved)) {
      return resolved
    }
  } catch {
    // Fall through to PATH.
  }
  try {
    const found = execFileSync('which', ['herdr'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}

/** Short XDG dirs so stock herdr's unix socket stays under the macOS sun_path limit. */
export function createStockHerdrXdgHome(): string {
  return mkdtempSync(join('/tmp', 'orca-h-'))
}

export function stockHerdrLaunchEnv(binary: string, xdgHome: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: xdgHome,
    XDG_RUNTIME_DIR: xdgHome,
    PATH: `${dirname(binary)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`
  }
}

export function removeStockHerdrXdgHome(xdgHome: string): void {
  rmSync(xdgHome, { recursive: true, force: true })
}

export async function openTerminalRuntimeSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'terminal', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByRole('radiogroup', { name: 'Default terminal backend' })).toBeVisible({
    timeout: 15_000
  })
}

export async function closeTerminalRuntimeSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().closeSettingsPage()
  })
}

export async function expectHerdrRuntimeSelection(
  page: Page,
  selection: HerdrRuntimeSelection
): Promise<void> {
  const backend = page.getByRole('radiogroup', { name: 'Default terminal backend' })
  await expect(backend.getByRole('radio', { name: 'Herdr' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  if (selection.binaryPath) {
    await expect(page.getByRole('textbox', { name: 'Custom Herdr executable path' })).toHaveValue(
      selection.binaryPath
    )
  }
}

export async function selectHerdrInSettings(
  page: Page,
  selection: HerdrRuntimeSelection
): Promise<void> {
  await openTerminalRuntimeSettings(page)
  await page
    .getByRole('radiogroup', { name: 'Default terminal backend' })
    .getByRole('radio', { name: 'Herdr' })
    .click()
  if (selection.binaryPath) {
    await page
      .getByRole('radiogroup', { name: 'Herdr installation source' })
      .getByRole('radio', { name: 'Custom' })
      .click()
    const pathInput = page.getByRole('textbox', { name: 'Custom Herdr executable path' })
    await expect(pathInput).toBeVisible()
    await pathInput.fill(selection.binaryPath)
  }
  await expectHerdrRuntimeSelection(page, selection)
  await closeTerminalRuntimeSettings(page)
}

export async function openHerdrProjectTerminal(page: Page, repoPath: string): Promise<string> {
  const worktreeId = await attachRepoAndOpenTerminal(page, repoPath, {
    terminalBackendPreference: 'herdr'
  })
  await ensureTerminalVisible(page, 30_000)
  return worktreeId
}

export async function assertLiveHerdrTerminal(
  page: Page,
  marker: { prefix: string; suffix: string },
  options: { tabCount?: number } = {}
): Promise<string> {
  const tabCount = options.tabCount ?? 1
  await expect(page.locator(SORTABLE_TAB)).toHaveCount(tabCount, { timeout: 30_000 })
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  expect(ptyId.startsWith('herdr:')).toBe(true)
  await focusActiveTerminalInput(page)
  await page.keyboard.type(splitMarkerEchoCommand(marker.prefix, marker.suffix))
  await page.keyboard.press('Enter')
  await waitForHerdrTerminalText(page, `${marker.prefix}${marker.suffix}`, 30_000)
  return ptyId
}

async function readActiveXtermBuffer(page: Page): Promise<string> {
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
    const terminal = pane?.terminal
    if (!terminal) {
      return ''
    }
    const buffer = terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  })
}

async function waitForHerdrTerminalText(
  page: Page,
  expected: string,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const serialized = await getTerminalContent(page)
        if (serialized.includes(expected)) {
          return true
        }
        return (await readActiveXtermBuffer(page)).includes(expected)
      },
      {
        timeout: timeoutMs,
        message: `Terminal did not contain "${expected}"`
      }
    )
    .toBe(true)
}

export async function assertRestoredHerdrTerminal(
  page: Page,
  marker: string,
  options: { worktreeId?: string } = {}
): Promise<string> {
  if (options.worktreeId) {
    await expect(
      page.locator(`[role="option"][data-worktree-id="${options.worktreeId}"]`)
    ).toHaveAttribute('aria-current', 'page', { timeout: 30_000 })
  }
  // Why: do not call ensureTerminalVisible here. That helper createTab()s when
  // hydration is still empty, which adds a second terminal next to the restored one.
  // Hidden worktree strips also mount extra sortable-tab nodes, so count is not 1.
  await expect(page.locator(SORTABLE_TAB).first()).toBeVisible({ timeout: 30_000 })
  const ptyId = await waitForActivePanePtyId(page, 30_000)
  expect(ptyId.startsWith('herdr:')).toBe(true)
  await waitForHerdrTerminalText(page, marker, 30_000)
  return ptyId
}

export async function assertHerdrSplitPanes(page: Page, marker: string): Promise<void> {
  const before = await waitForPaneIdentitySnapshot(page, 1)
  await splitActiveTerminalPane(page, 'vertical')
  await waitForPaneCount(page, 2)
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  const ptyIds = snapshot.panes.map((pane) => pane.ptyId)
  expect(ptyIds.every((ptyId) => ptyId?.startsWith('herdr:'))).toBe(true)
  expect(new Set(ptyIds).size).toBe(2)
  const newPane = snapshot.panes.find((pane) => pane.ptyId !== before.panes[0]?.ptyId)
  expect(newPane?.ptyId).toBeTruthy()
  await execInTerminal(page, newPane!.ptyId as string, `echo ${marker}`)
  await waitForTerminalOutput(page, marker, 30_000)
}
