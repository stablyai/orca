import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getBrowserTabs,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { nodeTerminalCommand } from './terminal-node-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

type LinkProbe = { clientX: number; clientY: number; tabId: string }

async function locateLink(page: Page, label: string): Promise<LinkProbe> {
  return page.evaluate((label) => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId ?? null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!tabId || !pane || !screen) {
      throw new Error('active terminal pane unavailable')
    }

    const buffer = pane.terminal.buffer.active
    for (let row = pane.terminal.rows - 1; row >= 0; row -= 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      const col = line?.translateToString(true).lastIndexOf(label) ?? -1
      if (col >= 0) {
        const rect = screen.getBoundingClientRect()
        return {
          clientX: rect.left + (col + label.length / 2) * (rect.width / pane.terminal.cols),
          clientY: rect.top + (row + 0.5) * (rect.height / pane.terminal.rows),
          tabId
        }
      }
    }
    throw new Error('OSC 8 label not visible in terminal viewport')
  }, label)
}

async function readLinkState(
  page: Page,
  tabId: string,
  label: string
): Promise<{
  bufferType: string
  serializedUri: boolean
  underlined: boolean
  uri: string | null
}> {
  return page.evaluate(
    ({ label, tabId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!pane) {
        throw new Error('terminal pane unavailable')
      }
      const buffer = pane.terminal.buffer.active
      for (let row = buffer.viewportY; row < buffer.viewportY + pane.terminal.rows; row += 1) {
        const line = buffer.getLine(row)
        const col = line?.translateToString(true).lastIndexOf(label) ?? -1
        if (col < 0) {
          continue
        }
        const cell = line?.getCell(col) as
          | (ReturnType<NonNullable<typeof line>['getCell']> & {
              extended?: { urlId?: number }
            })
          | undefined
        const linkId = cell?.extended?.urlId ?? 0
        const terminal = pane.terminal as unknown as {
          _core?: {
            _oscLinkService?: { getLinkData: (id: number) => { uri: string } | undefined }
          }
        }
        const uri = linkId
          ? (terminal._core?._oscLinkService?.getLinkData(linkId)?.uri ?? null)
          : null
        return {
          bufferType: buffer.type,
          serializedUri: uri ? pane.serializeAddon.serialize().includes(uri) : false,
          underlined: !!cell?.isUnderline(),
          uri
        }
      }
      throw new Error('OSC 8 label disappeared from terminal buffer')
    },
    { label, tabId }
  )
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Orca store unavailable')
    }
    state.setActiveTabType('terminal')
    state.setActiveTab(tabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page)).toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
}

test('restores and opens an OSC 8 link after its terminal is cold-parked', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({
      openLinksInApp: true,
      openLinksInAppPreferencePrompted: true
    })
  })
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const tabId = await getActiveTabId(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 15_000)

  const label = `#${randomUUID().slice(0, 6)}`
  const url = `https://example.com/orca-osc8-${randomUUID()}`
  const linkedOutput = `\x1b[?1049h\x1b[2J\x1b[H\x1b]8;id=cold-park;${url}\x1b\\${label}\x1b]8;;\x1b\\\n`
  await sendToTerminal(
    orcaPage,
    ptyId,
    `${nodeTerminalCommand(['-e', `process.stdout.write(${JSON.stringify(linkedOutput)})`])}\r`
  )
  await expect.poll(() => getTerminalContent(orcaPage, 4_000)).toContain(label)

  const baselineProbe = await locateLink(orcaPage, label)
  await orcaPage.mouse.move(baselineProbe.clientX, baselineProbe.clientY)
  await expect
    .poll(() => readLinkState(orcaPage, tabId, label))
    .toMatchObject({
      bufferType: 'alternate',
      serializedUri: true,
      underlined: true,
      uri: url
    })

  await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
    parkDelayMs: PARKING_DELAY_MS
  })
  await activateTerminalTab(orcaPage, tabId)
  await expect.poll(() => getTerminalContent(orcaPage, 4_000)).toContain(label)

  const restoredProbe = await locateLink(orcaPage, label)
  await orcaPage.mouse.move(restoredProbe.clientX, restoredProbe.clientY)
  await expect
    .poll(() => readLinkState(orcaPage, tabId, label))
    .toMatchObject({
      bufferType: 'alternate',
      serializedUri: true,
      underlined: true,
      uri: url
    })

  const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
  const modifier = isMac ? 'Meta' : 'Control'
  await orcaPage.keyboard.down(modifier)
  await orcaPage.mouse.down()
  await orcaPage.mouse.up()
  await orcaPage.keyboard.up(modifier)
  await expect
    .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).some((tab) => tab.url === url))
    .toBe(true)
})
