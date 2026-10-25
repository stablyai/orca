/**
 * Two desktops on one Unix login, on a real Docker SSH host:
 *
 * Desktop A runs another Orca version's managed server there, has added the host's repository to
 * it, and leaves a terminal running in it. Desktop B still has that repository from its relay-era
 * profile. B connects: it pairs with A's server as it runs (no upload, no restart), links its
 * project to the one A added instead of being refused, moves the rest, and A's terminal keeps
 * running.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { createRestartSession } from './helpers/orca-restart'
import { managedServer, reconnect, serverCall } from './helpers/orcad-convert-flow'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { startOrcadConvertHost, type OrcadConvertHost } from './helpers/orcad-convert-host'
import { callEnvironment } from './helpers/paired-host-terminal'
import { findOrcadMigrationSourceCutoverForTarget } from '../../src/main/ssh/orcad-migration-cutover-journal'
import { ORCAD_TEMPLATE_MANIFEST_FILENAME } from '../../src/shared/orcad-artifacts'

const HOST = process.env.ORCA_E2E_ORCAD_CONVERT_HOST
const TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE
test.skip(
  HOST !== 'docker' || !TEMPLATE,
  'Set ORCA_E2E_ORCAD_CONVERT_HOST=docker and ORCA_E2E_ORCAD_CONVERT_TEMPLATE'
)

const ServerRepoListSchema = z.object({
  result: z.object({ repos: z.array(z.object({ path: z.string() })) })
})

// A common template file whose bytes nothing reads at runtime; its digest names the version.
const VERSION_SEED_FILE = 'ripgrep/licenses/LICENSE-MIT'

/** The same build under another content version, as a desktop on another Orca release ships it. */
function otherVersionTemplate(source: string, destination: string): string {
  cpSync(source, destination, { recursive: true })
  const seed = join(destination, ...VERSION_SEED_FILE.split('/'))
  appendFileSync(seed, '\n')
  const manifestPath = join(destination, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.commonSha256[VERSION_SEED_FILE] = createHash('sha256')
    .update(readFileSync(seed))
    .digest('hex')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return destination
}

function hostRecord(host: OrcadConvertHost): { active: string | null } {
  return JSON.parse(host.exec!('cat /root/.orca-remote/orcad-active.json'))
}

function orcadPids(host: OrcadConvertHost): string {
  return host.exec!(
    'for f in /root/.orca-remote/orcad-*/.orcad-pid; do pid=$(cat "$f" 2>/dev/null) && ' +
      'kill -0 "$pid" 2>/dev/null && echo "$pid"; done; true'
  ).trim()
}

function sleeping(host: OrcadConvertHost, marker: string): boolean {
  return host.exec!(`pgrep -f "sleep ${marker}" >/dev/null && echo yes || echo no`).trim() === 'yes'
}

async function connectFresh(
  page: Page,
  host: OrcadConvertHost
): Promise<{ targetId: string; environmentId: string }> {
  const connected = await page.evaluate(async (input) => {
    const { target } = await window.api.ssh.addTarget({ target: input })
    const state = await window.api.ssh.connect({ targetId: target.id })
    return { targetId: target.id, managedServer: state?.managedServer ?? null }
  }, host.input)
  const server = connected.managedServer
  if (server?.kind !== 'managed') {
    throw new Error(`expected a managed server, got ${JSON.stringify(server)}`)
  }
  return { targetId: connected.targetId, environmentId: server.environmentId }
}

test('a relay-era desktop joins the server another version runs for the same login', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  test.setTimeout(20 * 60_000)
  const host = startOrcadConvertHost(HOST!, testInfo)
  const desktopA = createRestartSession(testInfo, {
    ORCA_ORCAD_TEMPLATE_PATH: otherVersionTemplate(
      TEMPLATE!,
      testInfo.outputPath('other-version-template')
    )
  })
  const desktopB = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    // 1. Desktop A deploys its version, adds the host's repository and starts a terminal in it.
    const a = await desktopA.launch()
    app = a.app
    await waitForSessionReady(a.page)
    const serverA = await connectFresh(a.page, host)
    await callEnvironment(a.page, serverA.environmentId, 'repo.add', { path: host.remoteRepoPath })
    const marker = String(800_000 + Math.floor(Math.random() * 100_000))
    await callEnvironment(a.page, serverA.environmentId, 'terminal.create', {
      worktree: `path:${host.remoteRepoPath}`,
      command: `exec sleep ${marker}`
    })
    await expect.poll(() => sleeping(host, marker), { timeout: 60_000 }).toBe(true)
    const versionA = hostRecord(host).active
    const pidA = orcadPids(host)
    expect(versionA).toBeTruthy()
    expect(pidA).not.toBe('')
    await desktopA.close(app)
    app = null

    // 2. Desktop B's relay-era profile already holds the same repository on the same host.
    const established = await desktopB.launch()
    app = established.app
    await waitForSessionReady(established.page)
    await desktopB.close(app)
    app = null
    // B's sidebar shows only this host; A's server keeps its own all-hosts view.
    const seeded = seedRelayEraProfile(
      desktopB.userDataDir,
      host.input,
      { repoPath: host.remoteRepoPath, folderPath: host.remoteFolderPath },
      { sidebarScopedToHost: true }
    )
    const b = await desktopB.launch()
    app = b.app
    await waitForSessionReady(b.page)
    const connected = await reconnect(b.page, seeded.targetId)
    await expect
      .poll(
        async () => {
          const server = await managedServer(b.page, seeded.targetId)
          const journal = findOrcadMigrationSourceCutoverForTarget(
            desktopB.userDataDir,
            seeded.targetId
          )
          return JSON.stringify({ server, phase: journal?.phase ?? null, connected })
        },
        { timeout: 10 * 60_000 }
      )
      .toContain('"kind":"managed"')

    // Paired with A's server as it runs: same version, same process, A's terminal untouched.
    expect(hostRecord(host).active).toBe(versionA)
    expect(orcadPids(host)).toBe(pidA)
    expect(sleeping(host, marker)).toBe(true)

    // Linked, not imported twice: the server keeps A's one project and gains B's folder.
    const journal = findOrcadMigrationSourceCutoverForTarget(desktopB.userDataDir, seeded.targetId)
    expect(journal).toMatchObject({
      phase: 'destination-committed',
      linkedRepositoryIds: [seeded.repoId]
    })
    const environments = await b.page.evaluate(() => window.api.runtimeEnvironments.list())
    const environmentB = environments.find((entry) => {
      const deployment = entry.orcadDeployment
      return deployment && 'sshTargetId' in deployment && deployment.sshTargetId === seeded.targetId
    })
    expect(environmentB).toBeTruthy()
    const repos = ServerRepoListSchema.parse(
      JSON.parse(await serverCall(b.page, environmentB!.id, 'repo.list'))
    ).result.repos
    expect(repos.filter((repo) => repo.path === host.remoteRepoPath)).toHaveLength(1)
    expect(await serverCall(b.page, environmentB!.id, 'folderWorkspace.list')).toContain(
      JSON.stringify(host.remoteFolderPath).slice(1, -1)
    )
    await b.page.screenshot({ path: testInfo.outputPath('shared-login-linked.png') })
  } finally {
    if (app) {
      // Either session's close quits whichever app is still running.
      await desktopB.close(app)
    }
    await desktopA.dispose()
    await desktopB.dispose()
    host.cleanup()
  }
})
