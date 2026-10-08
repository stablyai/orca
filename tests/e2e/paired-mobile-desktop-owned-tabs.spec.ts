/**
 * A server workspace's editor tabs live in the desktop's window, not on the server. The phone's
 * server-workspace client lists them from the desktop beside the server's tabs, in the desktop's
 * order, and sends each tab's calls to the host that holds it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'
import { scopeRpcClientToExecutionHost } from '../../mobile/src/transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../../mobile/src/transport/rpc-client'
import type { RpcResponse } from '../../mobile/src/transport/types'
import { MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY } from '../../src/shared/mobile-desktop-relay-contract'

const StripSchema = z.looseObject({
  tabs: z.array(
    z.looseObject({ id: z.string(), type: z.string(), relativePath: z.string().optional() })
  )
})
const ResponseSchema = z.union([
  z.looseObject({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.looseObject({
    id: z.string(),
    ok: z.literal(false),
    error: z.looseObject({ code: z.string(), message: z.string() })
  })
])

let requestId = 0
/** The phone's socket as the app's RpcClient, so the real server-workspace client runs over it. */
function socketRpcClient(socket: PairedMobileSocket): RpcClient {
  const reply = async (id: string): Promise<RpcResponse> => {
    let frame: unknown
    await expect
      .poll(() => (frame = socket.frames.find((candidate) => candidate.id === id)), {
        timeout: 30_000
      })
      .toBeDefined()
    return ResponseSchema.parse(frame)
  }
  return {
    sendRequest: async (method, params, options) => {
      const id = `owned-${++requestId}`
      socket.send(id, method, params, options?.executionHost)
      return reply(id)
    },
    subscribe: (method, params, onData, options) => {
      const id = `owned-${++requestId}`
      let delivered = 0
      socket.send(id, method, params, options?.executionHost)
      const timer = setInterval(() => {
        const frames = socket.frames.filter((candidate) => candidate.id === id)
        for (const frame of frames.slice(delivered)) {
          onData(frame.result)
        }
        delivered = frames.length
      }, 50)
      return () => clearInterval(timer)
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

const TITLE = "phone lists, places and opens the desktop's editor tabs in a server workspace"
// oxlint-disable-next-line no-empty-pattern -- the topology launches its own desktop, so no app fixture.
test(TITLE, async ({}, testInfo) => {
  test.setTimeout(180_000)
  const serverRepo = testInfo.outputPath('server-repo')
  mkdirSync(serverRepo, { recursive: true })
  writeFileSync(path.join(serverRepo, 'NOTES.md'), 'notes on the server\n')
  writeFileSync(path.join(serverRepo, 'a.ts'), 'export const a = 1\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
  git('init')
  git('add', '.')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')

  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop' },
    testInfo
  )
  let stopStrip = (): void => {}
  try {
    await host.client.call('repo.add', { path: serverRepo, kind: 'git' })
    let row: { id: string; hostId: string } | null = null
    await expect
      .poll(
        async () =>
          (row = await desktop.page.evaluate((folder) => {
            const worktree = window.__store
              ?.getState()
              .allWorktrees()
              .find((candidate) => candidate.path === folder)
            return worktree?.hostId?.startsWith('runtime:')
              ? { id: worktree.id, hostId: worktree.hostId }
              : null
          }, serverRepo)),
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const { id: worktreeId, hostId } = row!
    if (!hostId.startsWith('runtime:')) {
      throw new Error(`not a server workspace: ${hostId}`)
    }
    const worktree = `id:${worktreeId}`
    const socket = await phone.openSocket()
    const server = scopeRpcClientToExecutionHost(
      socketRpcClient(socket),
      `runtime:${hostId.slice('runtime:'.length)}`,
      true
    )
    let latest: z.infer<typeof StripSchema> | null = null
    stopStrip = server.subscribe('session.tabs.subscribe', { worktree }, (frame) => {
      latest = StripSchema.safeParse(frame).data ?? latest
    })
    const phoneStrip = () =>
      (latest?.tabs ?? []).map((tab) =>
        tab.type === 'file' || tab.type === 'markdown' ? `editor:${tab.relativePath}` : tab.type
      )

    // The phone opens a file on the server workspace; the desktop's window holds the tab.
    const opened = await server.sendRequest('files.open', { worktree, relativePath: 'NOTES.md' })
    expect(opened).toMatchObject({ ok: true, result: { opened: true } })
    await desktop.page.evaluate(
      ({ id, repo, environmentId }) =>
        window.__store?.getState().openFile(
          {
            filePath: `${repo}/a.ts`,
            relativePath: 'a.ts',
            worktreeId: id,
            language: 'typescript',
            runtimeEnvironmentId: environmentId,
            mode: 'edit'
          },
          { preview: false }
        ),
      { id: worktreeId, repo: serverRepo, environmentId: hostId.slice('runtime:'.length) }
    )

    // The desktop's strip, with each tab named as the phone's strip names it.
    const desktopStrip = () =>
      desktop.page.evaluate((id) => {
        const state = window.__store!.getState()
        const tabs = state.unifiedTabsByWorktree[id] ?? []
        return (state.groupsByWorktree[id] ?? []).flatMap((group) =>
          group.tabOrder.map((tabId) => {
            const tab = tabs.find((candidate) => candidate.id === tabId)
            return tab?.contentType === 'editor'
              ? `editor:${tab.entityId.split('/').pop()}`
              : `${tab?.contentType}`
          })
        )
      }, worktreeId)
    await expect
      .poll(() => phoneStrip().filter((entry) => entry.startsWith('editor:')), { timeout: 30_000 })
      .toEqual(['editor:NOTES.md', 'editor:a.ts'])
    expect(phoneStrip()).toEqual(await desktopStrip())

    // The desktop moves its tab past the server's terminal; the phone follows.
    await desktop.page.evaluate((id) => {
      const state = window.__store!.getState()
      const group = state.groupsByWorktree[id]![0]!
      const editor = state.unifiedTabsByWorktree[id]!.find((tab) => tab.entityId.endsWith('/a.ts'))!
      state.reorderUnifiedTabs(group.id, [
        ...group.tabOrder.filter((tabId) => tabId !== editor.id),
        editor.id
      ])
    }, worktreeId)
    await expect
      .poll(phoneStrip, { timeout: 30_000 })
      .toEqual(['editor:NOTES.md', 'terminal', 'editor:a.ts'])
    expect(await desktopStrip()).toEqual(['editor:NOTES.md', 'terminal', 'editor:a.ts'])

    // A desktop tab's own call goes to the desktop that holds it.
    const notes = latest!.tabs.find((tab) => tab.relativePath === 'NOTES.md')
    const read = await server.sendRequest('markdown.readTab', { worktree, tabId: notes?.id })
    expect(read).toMatchObject({ ok: true, result: { content: 'notes on the server\n' } })

    const status = await socketRpcClient(socket).sendRequest('status.get', {})
    expect(status).toMatchObject({
      ok: true,
      result: {
        capabilities: expect.arrayContaining([MOBILE_DESKTOP_OWNED_TABS_RUNTIME_CAPABILITY])
      }
    })
  } finally {
    stopStrip()
    await dispose()
  }
})
