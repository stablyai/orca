import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { encodePairingOffer } from '../../src/shared/pairing'
import { listEnvironments } from '../../src/shared/runtime-environment-store'
import { runProcess } from '../../src/shared/child-process/run-process'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../src/shared/protocol-version'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../src/shared/remote-runtime-shared-control-test-server'

test.afterAll(closeSharedControlTestServers)

for (const removal of ['GUI', 'CLI'] as const) {
  test(`${removal} removal archives the last host's unsaved draft before retiring its session`, async ({
    electronApp,
    orcaPage
  }) => {
    const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const server = await createSharedControlTestServer({
      resultForRequest: (method) =>
        method === 'status.get'
          ? { capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY], runtimeId: 'archive-test' }
          : { method }
    })
    const { environment } = await orcaPage.evaluate(
      (pairingCode) =>
        window.api.runtimeEnvironments.addFromPairingCode({ name: 'archive-fixture', pairingCode }),
      encodePairingOffer(server.pairing)
    )
    const status = await orcaPage.evaluate(
      (selector) => window.api.runtimeEnvironments.connect({ selector, timeoutMs: 10_000 }),
      environment.id
    )
    expect(status.ok).toBe(true)
    await expect
      .poll(() => ({ open: server.openClientCount(), authenticated: server.auths.length }), {
        timeout: 20_000
      })
      .toEqual({ open: 1, authenticated: 2 })
    const hostId = toRuntimeExecutionHostId(environment.id)
    const workspace = 'folder:archive-proof'
    const content = 'unsaved runtime draft\n\u0000\r\n🚢'
    const session = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [workspace]: [
          {
            filePath: '/removed/file.txt',
            relativePath: 'file.txt',
            worktreeId: workspace,
            language: 'plaintext',
            runtimeEnvironmentId: environment.id,
            dirtyDraftContent: content,
            lastKnownDiskSignature: 'recorded-baseline'
          }
        ]
      }
    }
    await orcaPage.evaluate(
      async ({ session, hostId }) => {
        await window.api.session.set(session, hostId)
        await window.api.session.flush()
      },
      { session, hostId }
    )
    expect(
      await orcaPage.evaluate(
        (hostId) => window.api.session.listHostIds().then((ids) => ids.includes(hostId)),
        hostId
      )
    ).toBe(true)
    const localBefore = await orcaPage.evaluate(() => window.api.session.get())
    if (removal === 'GUI') {
      const result = await orcaPage.evaluate(
        (selector) => window.api.runtimeEnvironments.remove({ selector }),
        environment.id
      )
      expect(result.removed.id).toBe(environment.id)
    } else {
      const cli = await runProcess({
        program: process.execPath,
        args: [
          path.join(process.cwd(), 'out/cli/index.js'),
          'environment',
          'rm',
          '--environment',
          environment.id,
          '--json'
        ],
        env: { ...process.env, ORCA_USER_DATA_PATH: userDataPath },
        timeoutMs: 30_000
      })
      expect(cli.code, cli.stderr || cli.stdout).toBe(0)
    }
    expect(listEnvironments(userDataPath)).toEqual([])
    await expect
      .poll(() => orcaPage.evaluate(() => window.api.session.listHostIds()), { timeout: 30_000 })
      .not.toContain(hostId)
    await expect.poll(() => server.openClientCount(), { timeout: 20_000 }).toBe(0)
    const profiles = await orcaPage.evaluate(() => window.api.orcaProfiles.list())
    const archiveRoot = path.join(
      userDataPath,
      'profiles',
      profiles.activeProfileId,
      'retired-runtime-sessions'
    )
    const archives = readdirSync(archiveRoot).map((file) =>
      JSON.parse(readFileSync(path.join(archiveRoot, file), 'utf8'))
    )
    expect(archives).toContainEqual(
      expect.objectContaining({
        version: 1,
        hostId,
        session: expect.objectContaining({ openFilesByWorktree: session.openFilesByWorktree })
      })
    )
    await orcaPage.evaluate(
      async ({ session, hostId }) => {
        await window.api.session.set(session, hostId)
        await window.api.session.patch({ activeTabId: 'late' }, hostId)
        await window.api.session.flush()
      },
      { session, hostId }
    )
    expect(await orcaPage.evaluate(() => window.api.session.listHostIds())).not.toContain(hostId)
    const newer = {
      ...session,
      openFilesByWorktree: {
        [workspace]: session.openFilesByWorktree[workspace].map((file) => ({
          ...file,
          dirtyDraftContent: `${content} latest before unload`
        }))
      }
    }
    await orcaPage.evaluate(
      async ({ newer, hostId }) => {
        await window.api.session.set(newer, hostId)
        await window.api.session.patch({ openFilesByWorktree: newer.openFilesByWorktree }, hostId)
        window.api.session.setSync(newer, hostId)
        await window.api.session.flush()
      },
      { newer, hostId }
    )
    const finalArchives = readdirSync(archiveRoot).map((file) =>
      JSON.parse(readFileSync(path.join(archiveRoot, file), 'utf8'))
    )
    expect(finalArchives).toHaveLength(2)
    expect(finalArchives).toContainEqual(
      expect.objectContaining({
        kind: 'late-editor-draft',
        hostId,
        session: expect.objectContaining({ openFilesByWorktree: newer.openFilesByWorktree })
      })
    )
    expect(await orcaPage.evaluate(() => window.api.session.listHostIds())).not.toContain(hostId)
    const localAfter = await orcaPage.evaluate(() => window.api.session.get())
    expect(localAfter.openFilesByWorktree).toEqual(localBefore.openFilesByWorktree)
  })
}
