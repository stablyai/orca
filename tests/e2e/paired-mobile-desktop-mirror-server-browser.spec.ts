/**
 * A browser page running on the server reaches a phone paired with the desktop: the phone opens it
 * in the server's workspace, sees its tab, and gets its screencast frames through the desktop relay.
 */
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'
import { z } from 'zod'

type Frame = PairedMobileSocket['frames'][number]

const HostWorktreesSchema = z.looseObject({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() })),
  stale: z.boolean()
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
