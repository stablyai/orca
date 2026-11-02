/**
 * E6: a phone paired with a desktop reaches that desktop's WSL host through the desktop, as it
 * reaches a managed SSH host, but never starts the distro. The HUB fixture stands in for the
 * distro's orcad behind a fake WSL transport; the oracle is the phone's wire.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime/client'
import {
  createDesktopMobilePairingOffer,
  createRuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { pairMobileClient, type PairedMobileSocket } from './helpers/paired-mobile-client'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { notificationExecutionHostForOwner } from '../../src/shared/notification-source'
import { waitForSessionReady } from './helpers/store'
import {
  fakeWslConnects,
  launchDesktopWithFakeWslPairing,
  setWslHostsEnabled
} from './helpers/wsl-host-fake-desktop'

const WSL_ENVIRONMENT_ID = 'wsl:ubuntu'
const UBUNTU = { name: 'Ubuntu', state: 'running', version: 2 }

type Frame = PairedMobileSocket['frames'][number]

const HostsSchema = z.object({
  hosts: z.array(
    z.looseObject({
      hostId: z.string(),
      relay: z.string(),
      stoppedOnDesktop: z.boolean().optional(),
      unavailableOnDesktop: z.boolean().optional()
    })
  )
})
// The host as the phone reads it; an absent flag reads false.
function hostReach(host: z.infer<typeof HostsSchema>['hosts'][number] | undefined) {
  return host
    ? {
        relay: host.relay,
        stopped: host.stoppedOnDesktop === true,
        unavailable: host.unavailableOnDesktop === true
      }
    : null
}
const HostWorktreesSchema = z.looseObject({
  worktrees: z
    .array(z.looseObject({ worktreeId: z.string(), path: z.string(), hostId: z.string() }))
    .nullable()
})
const DirectorySchema = z.array(z.looseObject({ name: z.string() }))
const CreatedTerminalSchema = z.object({ tab: z.looseObject({ terminal: z.string().nullable() }) })
const TerminalListSchema = z.looseObject({
  terminals: z.array(z.looseObject({ worktreeId: z.string(), ptyId: z.string().nullable() }))
})

let requestId = 0
async function send(socket: PairedMobileSocket, method: string, params: unknown, host?: string) {
  requestId += 1
  const id = `phone-${requestId}`
  socket.send(id, method, params, host)
  let frame: Frame | undefined
  await expect
    .poll(() => (frame = socket.frames.find((entry) => entry.id === id)), { timeout: 60_000 })
    .toBeDefined()
  return frame!
}

async function call<T>(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  host?: string
): Promise<T> {
  const frame = await send(socket, method, params, host)
  expect(frame.ok, `${method}: ${JSON.stringify(frame.error)}`).toBe(true)
  return schema.parse(frame.result)
}

function createGitProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-phone-project-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(path.join(dir, 'README.md'), '# wsl host phone project\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  )
  return dir
}

test("a paired phone lists, opens, runs and launches on the desktop's WSL host, and never starts it", async ({
  orcaPage,
  electronApp
}, testInfo) => {
  // Two Orca instances, a pairing, a terminal and an agent launch on a cold runner.
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  // The HUB is the "distro's orcad": its projects are the WSL host's projects.
  const hub = new RuntimeClient(await electronApp.evaluate(({ app }) => app.getPath('userData')))
  const projectPath = createGitProject()
  await hub.call('repo.add', { path: projectPath, kind: 'git' })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const distrosDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-phone-distros-'))
  const distrosFile = path.join(distrosDir, 'distros.json')
  const connectLogFile = path.join(distrosDir, 'connects.log')
  writeFileSync(distrosFile, JSON.stringify([UBUNTU]))
  const desktop = await launchDesktopWithFakeWslPairing(offer.pairingUrl, testInfo, {
    distrosFile,
    connectLogFile
  })
  const phone = pairMobileClient(await createDesktopMobilePairingOffer(desktop.page))
  const hostId = toRuntimeExecutionHostId(WSL_ENVIRONMENT_ID)
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)
    await page.evaluate(() => window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' }))
    expect(fakeWslConnects(connectLogFile).length).toBeGreaterThan(0)

    const socket = await phone.openSocket()
    try {
      // Listed beside the desktop's other servers, ready and with neither desktop-only flag.
      await expect
        .poll(
          async () =>
            hostReach(
              (await call(socket, 'mobileRelay.hosts.list', {}, HostsSchema)).hosts.find(
                (host) => host.hostId === hostId
              )
            ),
          { timeout: 90_000 }
        )
        .toEqual({ relay: 'ready', stopped: false, unavailable: false })

      let rows: z.infer<typeof HostWorktreesSchema>['worktrees'] = null
      await expect
        .poll(
          async () => {
            rows = (
              await call(socket, 'mobileRelay.hosts.worktrees', { hostId }, HostWorktreesSchema)
            ).worktrees
            return rows?.some((row) => row.hostId === hostId) ?? false
          },
          { timeout: 90_000 }
        )
        .toBe(true)
      const project = rows!.find((row) => row.hostId === hostId)!

      // A tapped push names the same host the rows do, so it opens here rather than on the desktop.
      expect(
        notificationExecutionHostForOwner({ executionHostId: hostId, runtimeEnvironmentId: null })
      ).toBe(hostId)
      const entries = await call(
        socket,
        'files.readDir',
        { worktree: `id:${project.worktreeId}`, relativePath: '' },
        DirectorySchema,
        hostId
      )
      expect(entries.map((entry) => entry.name)).toContain('README.md')

      const { tab } = await call(
        socket,
        'session.tabs.createTerminal',
        {
          worktree: `id:${project.worktreeId}`,
          activate: false,
          select: false,
          navigation: 'caller'
        },
        CreatedTerminalSchema,
        hostId
      )
      expect(tab.terminal, 'the WSL host created the terminal').toBeTruthy()

      // An agent launch is served by the WSL host itself: it adds a terminal there.
      const hubTerminals = async (): Promise<number> =>
        TerminalListSchema.parse((await hub.call('terminal.list')).result).terminals.filter(
          (terminal) => terminal.ptyId !== null && terminal.worktreeId === project.worktreeId
        ).length
      await expect.poll(hubTerminals, { timeout: 30_000 }).toBeGreaterThan(0)
      const beforeLaunch = await hubTerminals()
      const launch = await send(
        socket,
        'agent.launch',
        { agent: 'claude', target: { kind: 'existing', worktree: `id:${project.worktreeId}` } },
        hostId
      )
      expect(launch.error?.code ?? 'ok').not.toBe('remote_runtime_unavailable')
      await expect.poll(hubTerminals, { timeout: 30_000 }).toBeGreaterThan(beforeLaunch)
    } finally {
      socket.close()
    }

    // The distro stops. A phone asking now is told to start it on the computer, and nothing starts.
    writeFileSync(distrosFile, JSON.stringify([{ ...UBUNTU, state: 'stopped' }]))
    const connectsBeforeStop = fakeWslConnects(connectLogFile)
    const stopped = await phone.openSocket()
    try {
      const refused = await send(stopped, 'worktree.ps', { limit: 100 }, hostId)
      expect(refused.ok).toBe(false)
      expect(JSON.stringify(refused.error)).toContain('isn’t running')
      await expect
        .poll(
          async () =>
            hostReach(
              (await call(stopped, 'mobileRelay.hosts.list', {}, HostsSchema)).hosts.find(
                (host) => host.hostId === hostId
              )
            ),
          { timeout: 30_000 }
        )
        .toEqual({ relay: 'unavailable', stopped: true, unavailable: false })
      // A second refused call: anything a phone's call could start would have started by its answer.
      const refusedAgain = await send(stopped, 'worktree.ps', { limit: 100 }, hostId)
      expect(JSON.stringify(refusedAgain.error)).toContain('isn’t running')
      expect(fakeWslConnects(connectLogFile)).toEqual(connectsBeforeStop)
      // The fake boots a distro by rewriting this file, so it still reading stopped means nothing booted it.
      expect(
        z
          .array(z.looseObject({ name: z.string(), state: z.string() }))
          .parse(JSON.parse(readFileSync(distrosFile, 'utf8')))
          .find((entry) => entry.name === UBUNTU.name)?.state
      ).toBe('stopped')
    } finally {
      stopped.close()
    }
  } finally {
    phone.dispose()
    await desktop.dispose()
    rmSync(projectPath, { recursive: true, force: true })
    rmSync(distrosDir, { recursive: true, force: true })
  }
})
