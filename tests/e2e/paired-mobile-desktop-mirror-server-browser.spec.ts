// Relay the server browser’s tab and real screencast frames through a desktop to its paired phone.
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'
import { z } from 'zod'
import { createServer } from 'node:http'
import { RuntimeRpcEnvelopeSchema } from '../../src/shared/runtime-rpc-envelope'
import { startRuntimeCapabilityProbe } from '../../mobile/src/transport/runtime-capability-probe'
import { buildMobileBrowserScreencastRequest } from '../../mobile/src/browser/browser-screencast-request'
import {
  openClientHostedFixturePage,
  selectPairedWorktreeGroup,
  waitForPairedWorktreeId
} from './helpers/client-hosted-browser-fixture'

type Frame = PairedMobileSocket['frames'][number]

const HostWorktreesSchema = z.looseObject({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() }))
})
const CreatedSchema = z.looseObject({ browserPageId: z.string() })
const TabsSchema = z.looseObject({
  tabs: z.array(z.looseObject({ type: z.string(), browserPageId: z.string().optional() }))
})
const ReadySchema = z.looseObject({ type: z.literal('ready'), subscriptionId: z.string() })
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

let requestCount = 0
function nextId(label: string): string {
  requestCount += 1
  return `${label}-${requestCount}`
}

async function reply(socket: PairedMobileSocket, id: string, timeout = 30_000): Promise<Frame> {
  const find = (): Frame | undefined => socket.frames.find((frame) => frame.id === id)
  await expect.poll(find, { timeout }).toBeDefined()
  const found = find()
  if (!found) {
    throw new Error(`no reply to ${id}`)
  }
  return found
}

async function call<T>(
  socket: PairedMobileSocket,
  request: { id: string; method: string; params: unknown; executionHost: string },
  schema: z.ZodType<T>
): Promise<T> {
  socket.send(request.id, request.method, request.params, request.executionHost)
  const frame = await reply(socket, request.id)
  expect(frame.ok, `${request.method}: ${JSON.stringify(frame.error)}`).toBe(true)
  return schema.parse(frame.result)
}

test('phone paired with a desktop sees and streams a browser page running on its server', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop' },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    let serverHostId = ''
    await expect
      .poll(
        async () =>
          (serverHostId = await desktop.page.evaluate(
            (repo) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === repo)?.hostId ?? '',
            testRepoPath
          )),
        { timeout: 30_000 }
      )
      .toMatch(/^runtime:/)

    const socket = await phone.openSocket()
    let worktreeId = ''
    await expect
      .poll(async () => {
        const id = nextId('host-worktrees')
        socket.send(id, 'mobileRelay.hosts.worktrees', { hostId: serverHostId })
        const listed = HostWorktreesSchema.safeParse((await reply(socket, id)).result)
        worktreeId = listed.success
          ? (listed.data.worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? '')
          : ''
        return worktreeId
      })
      .not.toBe('')
    const worktree = `id:${worktreeId}`

    const { browserPageId } = await call(
      socket,
      {
        id: 'browser-create',
        method: 'browser.tabCreate',
        params: {
          worktree,
          url: 'data:text/html,<body style="background:%23c33"><h1>server page</h1></body>',
          activate: true
        },
        executionHost: serverHostId
      },
      CreatedSchema
    )

    // The server's tab list, read through the desktop, holds the page the server runs.
    await expect
      .poll(async () => {
        const { tabs } = await call(
          socket,
          {
            id: nextId('tabs'),
            method: 'session.tabs.list',
            params: { worktree },
            executionHost: serverHostId
          },
          TabsSchema
        )
        return tabs.some((tab) => tab.type === 'browser' && tab.browserPageId === browserPageId)
      })
      .toBe(true)

    socket.send(
      'screencast',
      'browser.screencast',
      {
        worktree,
        page: browserPageId,
        format: 'jpeg',
        quality: 72,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      },
      serverHostId
    )
    let subscriptionId = ''
    await expect
      .poll(() => {
        for (const frame of socket.frames) {
          const ready = ReadySchema.safeParse(frame.result)
          if (frame.id === 'screencast' && ready.success) {
            subscriptionId = ready.data.subscriptionId
          }
        }
        const failed = socket.frames.find((frame) => frame.id === 'screencast' && !frame.ok)
        expect(failed, `browser.screencast: ${JSON.stringify(failed?.error)}`).toBeUndefined()
        return subscriptionId
      })
      .not.toBe('')
    // The page paints on the phone: real JPEG frames the server encoded, passed through the desktop.
    await expect.poll(() => socket.screencastFrames.length, { timeout: 30_000 }).toBeGreaterThan(0)
    const [first] = socket.screencastFrames
    expect(first.format).toBe('jpeg')
    expect([...first.image.subarray(0, 3)]).toEqual(JPEG_MAGIC)

    await call(
      socket,
      {
        id: 'screencast-stop',
        method: 'browser.screencast.unsubscribe',
        params: { subscriptionId },
        executionHost: serverHostId
      },
      z.looseObject({ unsubscribed: z.literal(true) })
    )
  } finally {
    await dispose()
  }
})

test('phone streams and drives a desktop-hosted page and creates on the same desktop', async ({
  testRepoPath
}, testInfo) => {
  // Pairing two isolated Electron processes and closing real streams needs a bounded startup budget.
  test.setTimeout(240_000)
  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop', withoutBrowser: true },
    testInfo
  )
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(`<html><head><title>Desktop hosted</title></head><body style="background:#c33;color:white">
      <h1 id="marker">Desktop hosted</h1>
      <button style="position:absolute;left:24px;top:100px;width:300px;height:60px"
        onclick="document.body.style.background='#1365a1';document.querySelector('#marker').textContent='Phone clicked'">Click from phone</button>
      </body></html>`)
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fixture did not bind a TCP port')
    }
    const url = `http://127.0.0.1:${address.port}/`
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Browser relay'
    })
    const worktreeId = await waitForPairedWorktreeId(desktop.page, testRepoPath)
    await selectPairedWorktreeGroup(desktop.page, desktop.environmentId, worktreeId)
    const executionHost = `runtime:${desktop.environmentId}`
    const worktree = `id:${worktreeId}`
    const socket = await phone.openSocket()
    const statusSchema = z.looseObject({ runtimeId: z.string(), capabilities: z.array(z.string()) })
    const direct = statusSchema.parse((await host.client.call('status.get', {})).result)
    expect(direct.capabilities).not.toContain('browser.screencast.v1')
    let capabilities: readonly string[] = []
    let probes = 0
    const stopProbe = startRuntimeCapabilityProbe(
      {
        sendRequest: async (method, params) => {
          probes += 1
          socket.send('initial-status', method, params, executionHost)
          const response = RuntimeRpcEnvelopeSchema.parse(await reply(socket, 'initial-status'))
          if (!('ok' in response)) {
            throw new Error('Unexpected keepalive')
          }
          if (!response.ok) {
            throw new Error(response.error.message)
          }
          expect(response._meta.runtimeId).toBe(direct.runtimeId)
          return response
        }
      },
      (value) => {
        capabilities = value
      }
    )
    try {
      await expect.poll(() => capabilities, { timeout: 30_000 }).toContain('browser.screencast.v1')
      expect(probes).toBe(1)
    } finally {
      stopProbe()
    }
    const hosted = await openClientHostedFixturePage(desktop, worktreeId, url)
    socket.send(
      'cast-client',
      'browser.screencast',
      {
        worktree,
        page: hosted.remotePageId,
        format: 'jpeg',
        quality: 80,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      },
      executionHost
    )
    const ready = ReadySchema.parse((await reply(socket, 'cast-client')).result)
    await expect.poll(() => socket.screencastFrames.length).toBeGreaterThan(0)
    await testInfo.attach('phone-before-click', {
      body: Buffer.from(socket.screencastFrames.at(-1)!.image),
      contentType: 'image/jpeg'
    })
    const frameCount = socket.screencastFrames.length
    await call(
      socket,
      {
        id: 'phone-click',
        method: 'browser.mouseClick',
        params: {
          worktree,
          page: hosted.remotePageId,
          x: 100,
          y: 120,
          button: 'left'
        },
        executionHost
      },
      z.unknown()
    )
    await expect
      .poll(() =>
        desktop.page.evaluate(async (url) => {
          for (const guest of document.querySelectorAll<Electron.WebviewTag>('webview')) {
            if (guest.getURL().startsWith(url)) {
              return guest.executeJavaScript('document.querySelector("#marker")?.textContent')
            }
          }
          return null
        }, url)
      )
      .toBe('Phone clicked')
    await expect.poll(() => socket.screencastFrames.length).toBeGreaterThan(frameCount)
    await testInfo.attach('phone-after-click', {
      body: Buffer.from(socket.screencastFrames.at(-1)!.image),
      contentType: 'image/jpeg'
    })
    await testInfo.attach('desktop-after-phone-click', {
      body: await desktop.page.screenshot(),
      contentType: 'image/png'
    })
    await testInfo.attach('phone-stream', {
      body: Buffer.from(
        JSON.stringify(
          socket.screencastFrames.map((frame) => ({
            timestamp: frame.metadata.timestamp,
            image: Buffer.from(frame.image).toString('base64')
          }))
        )
      ),
      contentType: 'application/json'
    })
    await call(
      socket,
      {
        id: 'stop-client',
        method: 'browser.screencast.unsubscribe',
        params: { subscriptionId: ready.subscriptionId },
        executionHost
      },
      z.unknown()
    )
    const created = await call(
      socket,
      {
        id: 'phone-create-client',
        method: 'browser.tabCreate',
        params: {
          worktree,
          url: `${url}?phone-created`,
          activate: true
        },
        executionHost
      },
      CreatedSchema
    )
    const phoneTabs = await call(
      socket,
      {
        id: 'phone-created-tab',
        method: 'session.tabs.list',
        params: { worktree },
        executionHost
      },
      z.looseObject({
        tabs: z.array(
          z.looseObject({ browserPageId: z.string().optional(), placement: z.unknown().optional() })
        )
      })
    )
    expect(phoneTabs.tabs).toContainEqual(
      expect.objectContaining({
        browserPageId: created.browserPageId,
        placement: expect.objectContaining({ kind: 'client' })
      })
    )
    expect(
      await desktop.app.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().filter((page) => page.getURL() === url).length,
        `${url}?phone-created`
      )
    ).toBe(1)
    expect(
      await host.app.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().filter((page) => page.getURL() === url).length,
        `${url}?phone-created`
      )
    ).toBe(0)
    const createdFrameCount = socket.screencastFrames.length
    socket.send(
      'cast-created',
      'browser.screencast',
      {
        worktree,
        page: created.browserPageId,
        ...buildMobileBrowserScreencastRequest({ width: 390, height: 600 }, 2)
      },
      executionHost
    )
    const createdReady = ReadySchema.parse((await reply(socket, 'cast-created')).result)
    await expect.poll(() => socket.screencastFrames.length).toBeGreaterThan(createdFrameCount)
    await testInfo.attach('phone-created-page', {
      body: Buffer.from(socket.screencastFrames.at(-1)!.image),
      contentType: 'image/jpeg'
    })
    await call(
      socket,
      {
        id: 'stop-created',
        method: 'browser.screencast.unsubscribe',
        params: { subscriptionId: createdReady.subscriptionId },
        executionHost
      },
      z.unknown()
    )
    await expect
      .poll(() =>
        desktop.page
          .locator(`[data-browser-client-page-id="${created.browserPageId}"]`)
          .evaluate((el) => el.style.width)
      )
      .toBe('1px')
    expect(
      await desktop.page
        .locator(`[data-browser-client-page-id="${hosted.remotePageId}"]`)
        .evaluate((el) => el instanceof HTMLElement && el.inert)
    ).toBe(false)
    const blank = await call(
      socket,
      {
        id: 'phone-create-blank',
        method: 'browser.tabCreate',
        params: { worktree, activate: true },
        executionHost
      },
      CreatedSchema
    )
    const blankFrameCount = socket.screencastFrames.length
    socket.send(
      'cast-blank',
      'browser.screencast',
      {
        worktree,
        page: blank.browserPageId,
        ...buildMobileBrowserScreencastRequest({ width: 390, height: 600 }, 2)
      },
      executionHost
    )
    const blankReady = ReadySchema.parse((await reply(socket, 'cast-blank')).result)
    await expect.poll(() => socket.screencastFrames.length).toBeGreaterThan(blankFrameCount)
    await call(
      socket,
      {
        id: 'stop-blank',
        method: 'browser.screencast.unsubscribe',
        params: { subscriptionId: blankReady.subscriptionId },
        executionHost
      },
      z.unknown()
    )
    await expect
      .poll(() =>
        desktop.page
          .locator(`[data-browser-client-page-id="${blank.browserPageId}"]`)
          .evaluate((el) => el.style.width)
      )
      .toBe('1px')
    socket.send(
      'unsupported-server-create',
      'browser.tabCreate',
      { worktree, placement: { kind: 'server' } },
      executionHost
    )
    expect(await reply(socket, 'unsupported-server-create')).toMatchObject({
      ok: false,
      error: { message: 'This host does not support browser panes.' }
    })
    socket.send(
      'unsupported-server-page',
      'browser.screencast',
      { worktree, page: 'unhosted-page', format: 'jpeg' },
      executionHost
    )
    const unsupported = await reply(socket, 'unsupported-server-page')
    expect(unsupported).toMatchObject({ ok: false })
    expect(unsupported.error?.message).not.toMatch(/update/i)
  } finally {
    await dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
