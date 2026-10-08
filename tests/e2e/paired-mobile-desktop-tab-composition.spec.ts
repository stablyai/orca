/**
 * A phone paired with a desktop sees a server workspace's tab strip as the desktop arranged it:
 * the desktop writes every host-backed move through to the server, and the phone's relayed
 * `session.tabs.*` reads the server. With the desktop window closed, nothing changes for the phone.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'
import { toHostSessionTabId, toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { z } from 'zod'

type Frame = PairedMobileSocket['frames'][number]

const SORTABLE_TAB = '[data-testid="sortable-tab"]'
const HostWorktreesSchema = z.looseObject({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() })),
  stale: z.boolean()
})
const CreatedTerminalSchema = z.looseObject({
  tab: z.looseObject({ parentTabId: z.string() })
})
const SessionTabsSchema = z.looseObject({
  activeTabId: z.string().nullable(),
  tabGroups: z.array(z.looseObject({ id: z.string(), tabOrder: z.array(z.string()) })).optional(),
  tabs: z.array(z.looseObject({ id: z.string(), parentTabId: z.string().optional() }))
})

let requestId = 0
async function call<T>(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  executionHost?: string
): Promise<T> {
  requestId += 1
  const id = `${method}-${requestId}`
  socket.send(id, method, params, executionHost)
  let found: Frame | undefined
  await expect
    .poll(() => (found = socket.frames.find((frame) => frame.id === id)), { timeout: 30_000 })
    .toBeDefined()
  expect(found!.ok, `${method}: ${JSON.stringify(found!.error)}`).toBe(true)
  return schema.parse(found!.result)
}

/** Each tab group's tab order. Group ids are each host's own, so only order and membership compare. */
type Strip = string[][]

/** The desktop's tab groups for a workspace, each tab named by the server tab it mirrors. */
async function desktopStrip(page: Page, worktreeId: string): Promise<Strip> {
  const groups = await page.evaluate(
    (id) => (window.__store?.getState().groupsByWorktree[id] ?? []).map((group) => group.tabOrder),
    worktreeId
  )
  return groups.map((tabOrder) => tabOrder.map(toHostSessionTabId))
}

function desktopActiveTab(page: Page, worktreeId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const activeGroupId = state?.activeGroupIdByWorktree[id]
    return (
      state?.groupsByWorktree[id]?.find((group) => group.id === activeGroupId)?.activeTabId ?? null
    )
  }, worktreeId)
}

function desktopTab(page: Page, hostTabId: string) {
  return page.locator(`${SORTABLE_TAB}[data-tab-id="${toWebTerminalSurfaceTabId(hostTabId)}"]`)
}

/** Drops one desktop tab onto the leading edge of another, as a user drags in the tab strip. */
async function dragTab(page: Page, hostTabId: string, ontoHostTabId: string): Promise<void> {
  const from = (await desktopTab(page, hostTabId).boundingBox())!
  const onto = (await desktopTab(page, ontoHostTabId).boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(onto.x + onto.width * 0.25, onto.y + onto.height / 2, { steps: 8 })
  await page.mouse.up()
}

test('phone shows the desktop tab strip of a server workspace, also with the window closed', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its topology launch.
{}, testInfo) => {
  test.setTimeout(240_000)
  const serverFolder = testInfo.outputPath('server-folder')
  mkdirSync(serverFolder, { recursive: true })
  writeFileSync(`${serverFolder}/README.md`, 'server workspace\n')

  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop' },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: serverFolder, kind: 'folder' })
    let desktopWorktree = { id: '', hostId: '' }
    await expect
      .poll(
        async () =>
          (desktopWorktree = await desktop.page.evaluate((folder) => {
            const row = window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === folder)
            return { id: row?.id ?? '', hostId: row?.hostId ?? '' }
          }, serverFolder)).hostId,
        { timeout: 30_000 }
      )
      .toMatch(/^runtime:/)
    const serverHostId = desktopWorktree.hostId

    const socket = await phone.openSocket()
    let serverWorktreeId = ''
    await expect
      .poll(async () => {
        const listed = await call(
          socket,
          'mobileRelay.hosts.worktrees',
          { hostId: serverHostId },
          HostWorktreesSchema
        )
        serverWorktreeId =
          listed.worktrees.find((row) => row.path === serverFolder)?.worktreeId ?? ''
        return serverWorktreeId
      })
      .not.toBe('')
    const worktree = `id:${serverWorktreeId}`
    const phoneTabs = () =>
      call(socket, 'session.tabs.list', { worktree }, SessionTabsSchema, serverHostId)

    const created: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const { tab } = await call(
        socket,
        'session.tabs.createTerminal',
        { worktree, activate: false, select: false, navigation: 'caller' },
        CreatedTerminalSchema,
        serverHostId
      )
      created.push(tab.parentTabId)
    }

    await desktop.page.evaluate(
      (id) => window.__store?.getState().setActiveWorktree(id),
      desktopWorktree.id
    )
    await expect.poll(() => desktop.page.locator(SORTABLE_TAB).count(), { timeout: 30_000 }).toBe(3)

    // A server-placed browser page sits in the same strip.
    await call(
      socket,
      'browser.tabCreate',
      { worktree, url: 'about:blank', activate: false },
      z.looseObject({}),
      serverHostId
    )
    const phoneStrip = async (): Promise<Strip> =>
      ((await phoneTabs()).tabGroups ?? []).map((group) => group.tabOrder)
    await expect
      .poll(async () => (await desktopStrip(desktop.page, desktopWorktree.id))[0]?.length, {
        timeout: 30_000
      })
      .toBe(4)
    const [first, second, third] = created

    // Reorder on the desktop by dragging the third terminal onto the first.
    await dragTab(desktop.page, third, first)
    await expect
      .poll(async () => (await desktopStrip(desktop.page, desktopWorktree.id))[0]?.slice(0, 3))
      .toEqual([third, first, second])

    // Group on the desktop: move the second terminal into a split of its own.
    await desktopTab(desktop.page, second).click({ button: 'right' })
    await desktop.page.getByRole('menuitem', { name: 'Move Tab to Split' }).hover()
    await desktop.page.getByRole('menuitem', { name: 'Right', exact: true }).click()
    await expect
      .poll(async () => (await desktopStrip(desktop.page, desktopWorktree.id)).length)
      .toBe(2)
    await expect
      .poll(phoneStrip, { timeout: 30_000 })
      .toEqual(await desktopStrip(desktop.page, desktopWorktree.id))

    // Drag the first terminal into the group the desktop just split off.
    await dragTab(desktop.page, first, second)
    await expect
      .poll(async () =>
        (await desktopStrip(desktop.page, desktopWorktree.id)).find((group) =>
          group.includes(second)
        )
      )
      .toContain(first)
    const arranged = await desktopStrip(desktop.page, desktopWorktree.id)
    await expect.poll(phoneStrip, { timeout: 30_000 }).toEqual(arranged)
    // Only the server holds this workspace's tabs; the desktop's own answer has none of them.
    const untargeted = await call(socket, 'session.tabs.list', { worktree }, SessionTabsSchema)
    expect(untargeted.tabs).toEqual([])

    // Selection is each device's own, as for a local workspace.
    await call(
      socket,
      'session.tabs.activate',
      { worktree, tabId: first, navigation: 'caller' },
      z.looseObject({}),
      serverHostId
    )
    await desktopTab(desktop.page, third).click()
    await expect
      .poll(() => desktopActiveTab(desktop.page, desktopWorktree.id))
      .toBe(toWebTerminalSurfaceTabId(third))
    const phoneActive = async () => {
      const { activeTabId, tabs } = await phoneTabs()
      return tabs.find((candidate) => candidate.id === activeTabId)?.parentTabId
    }
    expect(await phoneActive()).toBe(first)

    // With the desktop window closed, the phone still reads the server's strip. Only macOS keeps
    // the app running without a window (window-all-closed-quit-policy.ts).
    if (process.platform !== 'darwin') {
      return
    }
    await desktop.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.close()
      }
    })
    await expect
      .poll(() => desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)
    expect(await phoneStrip()).toEqual(arranged)
    expect(await phoneActive()).toBe(first)
  } finally {
    await dispose()
  }
})
