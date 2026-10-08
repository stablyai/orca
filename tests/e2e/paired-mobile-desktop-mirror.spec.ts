/**
 * Phone paired with a desktop that is itself a client of an `orca serve` host: the phone reaches
 * the server's workspaces through the desktop by naming them with `executionHost: runtime:<env>`.
 * The desktop relays as the phone's own delegated device on the server.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import { openPairedSocket, type PairedMobileSocket } from './helpers/paired-mobile-client'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { decodePairingOffer } from '../../src/shared/pairing'
import { z } from 'zod'

type Frame = PairedMobileSocket['frames'][number]

const WorktreeListSchema = z.object({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() }))
})
const CreatedTerminalSchema = z.object({ tab: z.looseObject({ terminal: z.string().nullable() }) })
const SubscribedSchema = z.looseObject({ type: z.literal('subscribed'), streamId: z.number() })
const HostsSchema = z.object({
  hosts: z.array(z.looseObject({ hostId: z.string(), relay: z.string() }))
})
const DirectorySchema = z.array(z.looseObject({ name: z.string() }))
const GitStatusSchema = z.looseObject({ entries: z.array(z.looseObject({ path: z.string() })) })
const HostWorktreesSchema = z.looseObject({
  worktrees: z.array(
    z.looseObject({ worktreeId: z.string(), path: z.string(), hostId: z.string() })
  ),
  stale: z.boolean()
})

let pollId = 0
/** The server's rows as the phone lists them: through the desktop's own fetch. */
async function hostWorktrees(socket: PairedMobileSocket, hostId: string) {
  pollId += 1
  const id = `host-worktrees-${pollId}`
  socket.send(id, 'mobileRelay.hosts.worktrees', { hostId })
  const listed = HostWorktreesSchema.safeParse((await reply(socket, id)).result)
  return listed.success ? listed.data : null
}

async function reply(socket: PairedMobileSocket, id: string, timeout = 30_000): Promise<Frame> {
  let found: Frame | undefined
  await expect
    .poll(() => (found = socket.frames.find((frame) => frame.id === id)), { timeout })
    .toBeDefined()
  return found!
}

async function call<T>(
  socket: PairedMobileSocket,
  request: { id: string; method: string; params: unknown; executionHost?: string },
  schema: z.ZodType<T>
): Promise<T> {
  socket.send(request.id, request.method, request.params, request.executionHost)
  const frame = await reply(socket, request.id)
  expect(frame.ok, `${request.method}: ${JSON.stringify(frame.error)}`).toBe(true)
  return schema.parse(frame.result)
}

/** Opens a terminal on the workspace, subscribes and returns how to type into it. */
async function openTerminal(socket: PairedMobileSocket, worktreeId: string, host?: string) {
  const { tab } = await call(
    socket,
    {
      id: `create-${worktreeId}-${host ?? 'direct'}`,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${worktreeId}`,
        activate: false,
        select: false,
        navigation: 'caller'
      },
      executionHost: host
    },
    CreatedTerminalSchema
  )
  const terminal = tab.terminal ?? ''
  expect(terminal, 'the server publishes the terminal it created').not.toBe('')
  const client = { id: socket.token, type: 'mobile' }
  const subscribeId = `sub-${terminal}`
  socket.send(
    subscribeId,
    'terminal.subscribe',
    {
      terminal,
      client,
      viewport: { cols: 80, rows: 24 },
      capabilities: { terminalBinaryStream: 1 }
    },
    host
  )
  let streamId = -1
  await expect
    .poll(() => {
      for (const frame of socket.frames) {
        const subscribed = SubscribedSchema.safeParse(frame.result)
        if (frame.id === subscribeId && subscribed.success) {
          streamId = subscribed.data.streamId
        }
      }
      return streamId
    })
    .toBeGreaterThan(-1)
  let sent = 0
  const send = (text: string, enter: boolean): void => {
    sent += 1
    socket.send(`in-${terminal}-${sent}`, 'terminal.send', { terminal, text, enter, client }, host)
  }
  return {
    /** Runs `echo` of an arithmetic marker, so only an executed command prints the answer. */
    runMarker: async (label: string): Promise<void> => {
      send(`echo ${label}_$((1000+7))`, true)
      await socket.waitForOutput(streamId, `${label}_1007`, 20_000)
    },
    /** Time from sending a keystroke to its echo, then clears the line. */
    keystrokeEchoMs: async (key: string): Promise<number> => {
      const startedAt = performance.now()
      send(key, false)
      await socket.waitForOutput(streamId, key, 20_000)
      const elapsed = performance.now() - startedAt
      send('\x15', false)
      return elapsed
    }
  }
}

test('phone paired with a desktop lists, opens and types into a workspace on its server', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const serverFolder = testInfo.outputPath('server-folder')
  mkdirSync(serverFolder, { recursive: true })
  writeFileSync(path.join(serverFolder, 'README.md'), 'server workspace\n')
  // A git repo on the server too, so Source Control has a change to read there.
  const serverRepo = testInfo.outputPath('server-repo')
  mkdirSync(serverRepo, { recursive: true })
  writeFileSync(path.join(serverRepo, 'NOTES.md'), 'first\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
  git('init')
  git('add', 'NOTES.md')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')
  writeFileSync(path.join(serverRepo, 'NOTES.md'), 'changed on the server\n')

  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop', pinnedServePort: true },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: serverFolder, kind: 'folder' })
    await host.client.call('repo.add', { path: serverRepo, kind: 'git' })
    await new RuntimeClient(desktop.userDataDir, 5_000).call('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    // The desktop window shows the server's workspace, and names its host.
    let serverHostId = ''
    await expect
      .poll(
        async () =>
          (serverHostId = await desktop.page.evaluate(
            (folder) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === folder)?.hostId ?? '',
            serverFolder
          )),
        { timeout: 30_000 }
      )
      .toMatch(/^runtime:/)

    const socket = await phone.openSocket()
    const status = await call(
      socket,
      { id: 'status', method: 'status.get', params: {} },
      z.looseObject({ capabilities: z.array(z.string()) })
    )
    expect(status.capabilities).toContain('mobile.desktop-relay.v1')
    // The desktop's own list stays its own, exactly as an older page sees it.
    const list = { method: 'worktree.ps', params: { limit: 1_000 } }
    const local = await call(socket, { id: 'ps-local', ...list }, WorktreeListSchema)
    expect(local.worktrees.map((row) => row.path)).toContain(testRepoPath)
    expect(local.worktrees.map((row) => row.path)).not.toContain(serverFolder)

    const { hosts } = await call(
      socket,
      { id: 'hosts', method: 'mobileRelay.hosts.list', params: {} },
      HostsSchema
    )
    expect(hosts).toContainEqual(expect.objectContaining({ hostId: serverHostId, relay: 'ready' }))
    let listed: Awaited<ReturnType<typeof hostWorktrees>> = null
    await expect
      .poll(async () => {
        listed = await hostWorktrees(socket, serverHostId)
        return listed?.stale === false && listed.worktrees.some((row) => row.path === serverRepo)
      })
      .toBe(true)
    const serverRow = listed!.worktrees.find((row) => row.path === serverFolder)
    const serverRepoRow = listed!.worktrees.find((row) => row.path === serverRepo)
    expect(serverRow, 'the phone lists the server workspace through the desktop').toBeDefined()
    expect(new Set(listed!.worktrees.map((row) => row.hostId))).toEqual(new Set([serverHostId]))

    // Files and Source Control read the server's workspace there, and never on the desktop.
    const readDir = (worktreeId: string) => ({
      method: 'files.readDir',
      params: { worktree: `id:${worktreeId}`, relativePath: '' }
    })
    const gitStatus = (worktreeId: string) => ({
      method: 'git.status',
      params: { worktree: `id:${worktreeId}` }
    })
    const entries = await call(
      socket,
      { id: 'files', ...readDir(serverRow!.worktreeId), executionHost: serverHostId },
      DirectorySchema
    )
    expect(entries.map((entry) => entry.name)).toContain('README.md')
    const changes = await call(
      socket,
      { id: 'git', ...gitStatus(serverRepoRow!.worktreeId), executionHost: serverHostId },
      GitStatusSchema
    )
    expect(changes.entries.map((entry) => entry.path)).toContain('NOTES.md')
    for (const [id, request] of [
      ['files-desktop', readDir(serverRow!.worktreeId)],
      ['git-desktop', gitStatus(serverRepoRow!.worktreeId)]
    ] as const) {
      socket.send(id, request.method, request.params)
      expect((await reply(socket, id)).ok, `${request.method} untargeted`).toBe(false)
    }

    const relayed = await openTerminal(socket, serverRow!.worktreeId, serverHostId)
    await relayed.runMarker('MIRROR')
    const relayedMs: number[] = []
    for (let i = 0; i < 10; i += 1) {
      relayedMs.push(await relayed.keystrokeEchoMs(`rq${i}x`))
    }

    // The same echo on a socket paired straight to the server, for the cost of the extra hop.
    const direct = await openPairedSocket(decodePairingOffer(host.offer.pairingUrl))
    try {
      const directTerminal = await openTerminal(direct, serverRow!.worktreeId)
      await directTerminal.runMarker('DIRECT')
      const directMs: number[] = []
      for (let i = 0; i < 10; i += 1) {
        directMs.push(await directTerminal.keystrokeEchoMs(`dq${i}x`))
      }
      const latency = JSON.stringify({ relayedMs, directMs })
      console.log(`[mirror] keystroke echo ms ${latency}`)
      await testInfo.attach('echo-latency-ms', { body: latency, contentType: 'application/json' })
    } finally {
      direct.close()
    }

    await host.restartServeProcess({
      betweenProcesses: async () => {
        // The server is down: its workspace stays listed, marked stale, never synthesized away.
        await expect
          .poll(
            async () => {
              const stale = await hostWorktrees(socket, serverHostId)
              return (
                stale?.stale === true && stale.worktrees.some((row) => row.path === serverFolder)
              )
            },
            { timeout: 60_000, intervals: [1_000] }
          )
          .toBe(true)
        // A relayed call fails as unavailable, and never runs on the desktop instead.
        socket.send('ps-stopped', 'worktree.ps', { limit: 1_000 }, serverHostId)
        const stopped = await reply(socket, 'ps-stopped', 60_000)
        expect(stopped.ok).toBe(false)
        expect(stopped.error?.code).toBe('remote_runtime_unavailable')
        for (const [id, request] of [
          ['files-stopped', readDir(serverRow!.worktreeId)],
          ['git-stopped', gitStatus(serverRepoRow!.worktreeId)]
        ] as const) {
          socket.send(id, request.method, request.params, serverHostId)
          const failed = await reply(socket, id, 60_000)
          expect(failed.ok, `${request.method} while the server is down`).toBe(false)
          expect(failed.error?.code).toBe('remote_runtime_unavailable')
        }
      }
    })
    // Back up: the listing is fresh again, and the same phone socket reaches the server.
    await expect
      .poll(async () => (await hostWorktrees(socket, serverHostId))?.stale, {
        timeout: 90_000,
        intervals: [2_000]
      })
      .toBe(false)
    const reopened = await call(
      socket,
      { id: 'ps-restarted', ...list, executionHost: serverHostId },
      WorktreeListSchema
    )
    expect(reopened.worktrees.map((row) => row.path)).toContain(serverFolder)
  } finally {
    await dispose()
  }
})
