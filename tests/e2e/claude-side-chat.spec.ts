import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'

const PARENT_SESSION = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'

type StubLaunch = { argv: string[]; cwd: string }

function readLaunches(sink: string): StubLaunch[] {
  try {
    return readFileSync(sink, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): StubLaunch => JSON.parse(line))
  } catch {
    return []
  }
}

function paneTitles(page: Page): Promise<string[]> {
  return page.locator('.pane-title-text').allTextContents()
}

function activeLeafId(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate(
    (id) => window.__paneManagers?.get(id)?.getActivePane?.()?.leafId ?? null,
    tabId
  )
}

test('opens an ephemeral Claude side chat beside its parent and follows the parent', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The stub agent is a POSIX script')
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-side-chat-')))
  registerPostElectronShutdownCleanup(async () => rmSync(dir, { recursive: true, force: true }))
  const sink = join(dir, 'launches.jsonl')
  const stub = join(dir, 'claude')
  writeFileSync(
    stub,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(sink)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd()}) + '\\n')
process.stdout.write('SIDE CHAT STUB READY\\r\\n')
process.stdin.resume()
`
  )
  chmodSync(stub, 0o755)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await orcaPage.evaluate(async (command) => {
    await window.__store!.getState().updateSettings({ agentCmdOverrides: { claude: command } })
  }, stub)
  const parent = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId, parentLeafId] = parent.paneKey.split(':')
  const endpoint = await readHookEndpoint(electronApp)
  await postClaudeHook(endpoint, parent, {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: PARENT_SESSION,
    transcript_path: join(dir, `${PARENT_SESSION}.jsonl`),
    cwd: dir
  })
  await postClaudeHook(endpoint, parent, {
    hook_event_name: 'UserPromptSubmit',
    session_id: PARENT_SESSION,
    prompt: 'refactor the parser'
  })

  await openTerminalContextMenu(orcaPage)
  await orcaPage.getByRole('menuitem', { name: 'Open Side Chat' }).click()
  await waitForPaneCount(orcaPage, 2)
  await expect.poll(() => readLaunches(sink).length, { timeout: 15_000 }).toBe(1)

  const [launch] = readLaunches(sink)
  expect(launch.cwd).toBe(dir)
  const forkAt = launch.argv.indexOf('--resume')
  expect(launch.argv.slice(forkAt, forkAt + 4)).toEqual([
    '--resume',
    PARENT_SESSION,
    '--fork-session',
    '--session-id'
  ])
  expect(launch.argv[forkAt + 4]).toMatch(/^05ca51de-/)
  const settings = JSON.parse(launch.argv[launch.argv.indexOf('--settings') + 1])
  expect(settings.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe('1')
  expect(settings.hooks.SessionStart[0].matcher).toBe('fork')

  await expect.poll(() => paneTitles(orcaPage)).toContain('Side chat · from main · main working')
  await expect.poll(() => activeLeafId(orcaPage, tabId)).not.toBe(parentLeafId)
  const sideLeafId = await activeLeafId(orcaPage, tabId)
  await orcaPage.screenshot({ path: testInfo.outputPath('side-chat-open.png') })

  await postClaudeHook(endpoint, parent, {
    hook_event_name: 'Stop',
    session_id: PARENT_SESSION,
    last_assistant_message: 'parser refactored'
  })
  await expect.poll(() => paneTitles(orcaPage)).toContain('Side chat · from main · main finished')

  const toggle = process.platform === 'darwin' ? 'Meta+Alt+KeyS' : 'Control+Alt+KeyS'
  await orcaPage.keyboard.press(toggle)
  await expect.poll(() => activeLeafId(orcaPage, tabId)).toBe(parentLeafId)
  await orcaPage.keyboard.press(toggle)
  await expect.poll(() => activeLeafId(orcaPage, tabId)).toBe(sideLeafId)
  // Toggling reuses the open side chat rather than forking again.
  expect(readLaunches(sink)).toHaveLength(1)
  expect(await countVisibleTerminalPanes(orcaPage)).toBe(2)

  // A click on either half moves focus there, so the keyboard follows the pointer.
  const panes = orcaPage.locator('.xterm:visible')
  await panes.nth(0).click({ position: { x: 60, y: 60 } })
  await expect.poll(() => activeLeafId(orcaPage, tabId)).toBe(parentLeafId)
  await panes.nth(1).click({ position: { x: 60, y: 60 } })
  await expect.poll(() => activeLeafId(orcaPage, tabId)).toBe(sideLeafId)

  // The side panel resizes like any split: drag the divider left to widen it.
  const sideWidth = async (): Promise<number> => (await panes.nth(1).boundingBox())?.width ?? 0
  const widthBefore = await sideWidth()
  const divider = orcaPage.locator('.pane-divider.is-vertical:visible').first()
  const handle = await divider.boundingBox()
  expect(handle).not.toBeNull()
  const midY = handle!.y + handle!.height / 2
  await orcaPage.mouse.move(handle!.x + handle!.width / 2, midY)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(handle!.x - 200, midY, { steps: 10 })
  await orcaPage.mouse.up()
  await expect.poll(sideWidth).toBeGreaterThan(widthBefore + 150)
  await orcaPage.screenshot({ path: testInfo.outputPath('side-chat-resized.png') })

  // The tab menu reaches the same side chat without a pane under the pointer.
  await panes.nth(0).click({ position: { x: 60, y: 60 } })
  await orcaPage
    .locator('[data-testid="sortable-tab"][data-active="true"]')
    .click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: /Open Side Chat/ }).click()
  await expect.poll(() => activeLeafId(orcaPage, tabId)).toBe(sideLeafId)
  expect(readLaunches(sink)).toHaveLength(1)

  const isMac = process.platform === 'darwin'
  await orcaPage
    .locator('.xterm:visible')
    .nth(1)
    .click({
      button: isMac ? 'left' : 'right',
      position: { x: 40, y: 40 },
      modifiers: isMac ? ['Control'] : []
    })
  await expect(orcaPage.getByRole('menuitem', { name: 'Back to Main Chat' })).toBeVisible()
  await expect(orcaPage.getByRole('menuitem', { name: 'Open Side Chat' })).toHaveCount(0)
  await orcaPage.keyboard.press('Escape')
  await orcaPage.screenshot({ path: testInfo.outputPath('side-chat-finished.png') })

  // The side chat goes away with its parent, like Codex discarding it with the thread.
  await orcaPage.evaluate(
    ({ tabId, leafId }) =>
      window.dispatchEvent(
        new CustomEvent('orca-close-terminal-pane', { detail: { tabId, leafId } })
      ),
    { tabId, leafId: parentLeafId }
  )
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) =>
          Object.values(window.__store!.getState().tabsByWorktree)
            .flat()
            .some((tab) => tab.id === id),
        tabId
      )
    )
    .toBe(false)
})

test('closes a restored side chat pane whose ephemeral fork is gone', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const parent = await waitForActivePaneHookDescriptor(orcaPage)
  await splitActiveTerminalPane(orcaPage, 'vertical')
  await waitForPaneCount(orcaPage, 2)
  const orphan = await waitForActivePaneHookDescriptor(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  expect(orphan.paneKey).not.toBe(parent.paneKey)
  const endpoint = await readHookEndpoint(electronApp)

  // Same shape a side chat's Claude reports; no live pairing exists, as after a restart.
  await postClaudeHook(endpoint, orphan, {
    hook_event_name: 'SessionStart',
    source: 'fork',
    session_id: '05ca51de-0d3b-8c5e-8f6a-1b2c3d4e5f60'
  })
  await postClaudeHook(endpoint, orphan, {
    hook_event_name: 'UserPromptSubmit',
    session_id: '05ca51de-0d3b-8c5e-8f6a-1b2c3d4e5f60',
    prompt: 'what changed?'
  })
  await waitForPaneCount(orcaPage, 1)
})
