/**
 * JOURNEY: a paired client holding a mirrored editor tab survives a real quit/relaunch without
 * republishing it, and host-owned files in an SSH worktree stay published (no false exclusion).
 *
 * TOPOLOGY: the `orcaPage` app is host A (seeded repo, worktree wtA); client B pairs to A and is
 * relaunched on the same profile. The SSH test routes a worktree on A through localhost sshd.
 *
 * ORACLES (in order of authority):
 *  - `session.tabs.listAll` on the client's OWN runtime socket, sampled from the first answer after
 *    relaunch; a file tab for a worktree the client merely mirrors is exactly "republished".
 *  - Real SQLite bytes (`readPersistedProfileState`) through the real load validator
 *    (`parseWorkspaceSessionSalvaging`).
 *  - Store rows (`openFiles`) for row counts, owner ids and the mirror marker.
 *
 * POSITIVE CONTROL: a seeded legacy unmarked row must show up in the relaunched client's
 * inventory, otherwise "never republished" cannot be trusted.
 *
 * Run (after `VITE_EXPOSE_STORE=true pnpm exec electron-vite build --mode e2e && pnpm run build:cli`):
 *   ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm exec playwright test \
 *     tests/e2e/paired-editor-mirror-echo-restart-ssh.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 * SSH test: add ORCA_E2E_SSH_LOCALHOST=1 (needs a reachable localhost sshd and `pnpm run build:relay`).
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import type { RuntimeFileOpenResult } from '../../src/shared/runtime-file-contracts'
import type { SshTargetCreateInput } from '../../src/shared/ssh-types'
import { parseWorkspaceSessionSalvaging } from '../../src/shared/workspace-session-salvage'
import { cleanupTestRepository } from './global-teardown'
import { INDEX_SUFFIX, README_SUFFIX } from './helpers/editor-mirror-peer-setup'
import {
  readPartitions,
  scanPartitions,
  type PartitionHit,
  type PersistedRoot
} from './helpers/editor-mirror-persisted-partitions'
import {
  activateHostWorktreeOnClient,
  closeFileById,
  isMirrorOf,
  openLocalFile,
  readOpenFileRows,
  type OpenFileRow
} from './helpers/editor-mirror-renderer-store'
import {
  expectNoRepublication,
  hasEditorTab,
  listAll,
  startListAllSampler
} from './helpers/editor-mirror-session-inventory'
import { log, sleep, soak } from './helpers/editor-mirror-soak'
import { sshLocalhostPreflight } from './helpers/localhost-ssh-target-preflight'
import { expect, test } from './helpers/orca-app'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { createSeededTestRepo } from './helpers/seeded-test-repo'
import { connectSshTestTarget } from './helpers/ssh-test-target-connection'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('client holding a mirror survives a real quit/relaunch without republishing; legacy unmarked row stays readable', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  const wtA = await waitForActiveWorktree(orcaPage)
  const indexPath = path.join(testRepoPath, 'src', 'index.ts')
  const readmePath = path.join(testRepoPath, 'README.md')

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const B = await launchPairedElectronClient(offer, testInfo, 'restart')
  const userDataDir = B.userDataDir
  const envA = B.environmentId
  const bClient = new RuntimeClient(userDataDir, 30_000, null, null)
  // Exactly one of these owns the profile at any time; the finally block disposes whichever is live.
  let live: PairedElectronClient | null = B
  try {
    await waitForPairedClientWorktree(B.page, wtA)
    await activateHostWorktreeOnClient(B, wtA)

    await openLocalFile(orcaPage, {
      filePath: indexPath,
      relativePath: INDEX_SUFFIX,
      worktreeId: wtA,
      language: 'typescript'
    })
    const localId = (await readOpenFileRows(orcaPage, INDEX_SUFFIX))[0]?.id
    expect(localId).toBeDefined()
    await expect
      .poll(
        async () =>
          (await readOpenFileRows(B.page, INDEX_SUFFIX)).filter((row) => isMirrorOf(row, wtA, envA))
            .length,
        { timeout: 60_000, message: 'B never mirrored src/index.ts' }
      )
      .toBe(1)

    // --- STEP 1: marker on disk while running, through the real load validator.
    const expectMarkedRowOnDisk = async (label: string): Promise<PartitionHit> => {
      await expect
        .poll(() => scanPartitions(userDataDir, wtA, INDEX_SUFFIX).length, {
          timeout: 30_000,
          message: `${label}: no persisted row for src/index.ts in any workspace-session partition`
        })
        .toBeGreaterThan(0)
      const hits = scanPartitions(userDataDir, wtA, INDEX_SUFFIX)
      log(
        `${label}: persisted hits ${JSON.stringify(
          hits.map((hit) => ({
            partition: hit.partition,
            key: hit.key,
            marker: hit.row.mirroredFromRuntimeSession
          }))
        )} (expected partition key ${toRuntimeExecutionHostId(envA)})`
      )
      expect(hits, `${label}: the mirror row must live in exactly one partition`).toHaveLength(1)
      expect(hits[0].row.mirroredFromRuntimeSession, `${label}: marker not persisted`).toBe(true)
      const parsed = parseWorkspaceSessionSalvaging(readPartitions(userDataDir)[hits[0].partition])
      expect(parsed.ok, `${label}: partition failed the load validator`).toBe(true)
      if (parsed.ok) {
        expect(parsed.droppedCount, `${label}: validator dropped ${parsed.droppedPaths}`).toBe(0)
        const validated = parsed.value.openFilesByWorktree?.[hits[0].key]?.find((row) =>
          row.filePath.endsWith(INDEX_SUFFIX)
        )
        expect(
          validated?.mirroredFromRuntimeSession,
          `${label}: validator stripped the marker`
        ).toBe(true)
      }
      return hits[0]
    }
    const beforeQuit = await expectMarkedRowOnDisk('before quit')
    await expectNoRepublication('B listAll before quit', bClient, wtA, INDEX_SUFFIX)

    // --- STEP 2: quit preserving the profile; the flush must keep the marker.
    await B.quitPreservingProfile()
    live = null
    const afterQuit = scanPartitions(userDataDir, wtA, INDEX_SUFFIX)
    expect(afterQuit).toHaveLength(1)
    expect(afterQuit[0].row.mirroredFromRuntimeSession).toBe(true)
    expect(afterQuit[0].partition).toBe(beforeQuit.partition)

    // --- STEP 3: seed a legacy unmarked row (distinct path) into the same partition.
    const seedLegacyReadme = (): void => {
      mutateStoppedProfileState(userDataDir, (state) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test owns the profile; the partition/key were just read from it.
        const root = state as PersistedRoot
        const partition =
          beforeQuit.partition === 'local'
            ? root.workspaceSession
            : root.workspaceSessionsByHostId?.[beforeQuit.partition]
        const rows = partition?.openFilesByWorktree?.[beforeQuit.key]
        if (!rows) {
          throw new Error(
            `Partition ${beforeQuit.partition}/${beforeQuit.key} vanished before seeding the legacy row`
          )
        }
        if (
          !rows.some(
            (row) => typeof row.filePath === 'string' && row.filePath.endsWith(README_SUFFIX)
          )
        ) {
          rows.push({
            filePath: readmePath,
            relativePath: README_SUFFIX,
            worktreeId: wtA,
            language: 'markdown',
            runtimeEnvironmentId: envA
          })
        }
      })
    }
    seedLegacyReadme()
    expect(scanPartitions(userDataDir, wtA, README_SUFFIX)).toHaveLength(1)

    // --- STEP 4: relaunch on the same profile and sample the inventory from the first answer.
    type HydrationGate = {
      catalogHasWt: boolean
      catalog: string[]
      indexRows: OpenFileRow[]
      readmeRows: OpenFileRow[]
    }
    const readHydrationGate = async (page: Page): Promise<HydrationGate> => {
      const catalog = await page.evaluate(() =>
        Object.values(window.__store?.getState().worktreesByRepo ?? {})
          .flat()
          .map((w) => w.id)
      )
      return {
        catalogHasWt: catalog.includes(wtA),
        catalog,
        indexRows: await readOpenFileRows(page, INDEX_SUFFIX),
        readmeRows: await readOpenFileRows(page, README_SUFFIX)
      }
    }
    const relaunch = async (): Promise<{
      client: PairedElectronClient
      sampler: ReturnType<typeof startListAllSampler>
      gate: HydrationGate
    }> => {
      const client = await launchPairedElectronClient(offer, testInfo, 'restart', {
        reuseUserDataDir: userDataDir
      })
      live = client
      const sampler = startListAllSampler(bClient, wtA, 500)
      const gate = await readHydrationGate(client.page)
      log(
        `right after relaunch: catalogHasWt=${gate.catalogHasWt} catalog=${JSON.stringify(gate.catalog)} indexRows=${JSON.stringify(gate.indexRows)} readmeRows=${JSON.stringify(gate.readmeRows)}`
      )
      return { client, sampler, gate }
    }
    const isGated = (gate: HydrationGate): boolean =>
      !gate.catalogHasWt && gate.indexRows.length === 0 && gate.readmeRows.length === 0

    let relaunched = await relaunch()
    if (isGated(relaunched.gate)) {
      // hydrateEditorSession runs once at startup with the catalog of that moment; if wtA was not
      // in it, both rows are dropped for a reason unrelated to the marker. Retry once.
      log('HYDRATION GATING (startup catalog did not contain wtA): retrying the relaunch once')
      await relaunched.sampler.stop()
      await relaunched.client.quitPreservingProfile()
      live = null
      if (scanPartitions(userDataDir, wtA, INDEX_SUFFIX).length === 0) {
        throw new Error(
          'HYDRATION GATING (not a mirror-echo defect): the gated startup rewrote the profile without the marked row, so a retry cannot observe it'
        )
      }
      seedLegacyReadme()
      relaunched = await relaunch()
      if (isGated(relaunched.gate)) {
        await relaunched.sampler.stop()
        throw new Error(
          'HYDRATION GATING (not a mirror-echo defect): wtA absent from the startup catalog on both relaunch attempts; marker/republication assertions were not reached'
        )
      }
    }
    const B2 = relaunched.client
    const sampler = relaunched.sampler
    await waitForPairedClientWorktree(B2.page, wtA)
    await activateHostWorktreeOnClient(B2, wtA)

    // (a) disk after relaunch.
    await expectMarkedRowOnDisk('after relaunch')

    // (b) restored mirror: log the id transition (owned `editor:` id from hydration -> bare path
    //     after A's first post-relaunch snapshot), then require exactly one marked row.
    const idsSeen = new Set<string>()
    await expect
      .poll(
        async () => {
          const rows = await readOpenFileRows(B2.page, INDEX_SUFFIX)
          for (const row of rows) {
            idsSeen.add(`${row.id}|marker=${String(row.mirroredFromRuntimeSession)}`)
          }
          return rows.some((row) => row.id === indexPath)
        },
        {
          timeout: 60_000,
          message: `B2 never received A's post-relaunch snapshot (no bare-path row); ids seen: ${[...idsSeen].join(', ')}`
        }
      )
      .toBe(true)
    log(`B2 src/index.ts id transition: ${[...idsSeen].join(' -> ')}`)
    await expect
      .poll(
        async () => {
          const rows = await readOpenFileRows(B2.page, INDEX_SUFFIX)
          return rows.length === 1 && rows[0].mirroredFromRuntimeSession === true
        },
        {
          timeout: 30_000,
          message: `B2 does not hold exactly one marked src/index.ts row: ${JSON.stringify(
            await readOpenFileRows(B2.page, INDEX_SUFFIX)
          )}`
        }
      )
      .toBe(true)

    // (c) legacy unmarked row: hydrated, unmarked, and published — the positive control for the
    //     listAll oracle on this client. If it never shows up the oracle is invalid, not passing.
    await expect
      .poll(async () => (await readOpenFileRows(B2.page, README_SUFFIX)).length, {
        timeout: 30_000,
        message: 'legacy README.md row was not hydrated on B2'
      })
      .toBeGreaterThan(0)
    const readmeRows = await readOpenFileRows(B2.page, README_SUFFIX)
    log(`B2 README.md rows: ${JSON.stringify(readmeRows)}`)
    expect(readmeRows.some((row) => row.mirroredFromRuntimeSession === undefined)).toBe(true)
    await expect
      .poll(async () => hasEditorTab(await listAll(bClient), wtA, README_SUFFIX), {
        timeout: 60_000,
        message:
          'oracle invalid: the legacy unmarked README.md row never appeared in B2 listAll, so "src/index.ts was never republished" cannot be trusted'
      })
      .toBe(true)
    // Once every row is in place the assertions above finish in well under a second, which would
    // leave a single sample; keep sampling through a steady-state window before judging the set.
    const steadyStateMs = 10_000
    await sleep(steadyStateMs)
    const samples = await sampler.stop()
    const errored = samples.filter((sample) => sample.error)
    const withSnapshot = samples.filter((sample) => sample.hasSnapshot)
    log(
      `listAll samples: ${samples.length} total, ${withSnapshot.length} with wtA snapshot, ${errored.length} errored (first error: ${errored[0]?.error ?? 'none'}); first answer took ${samples[0]?.durationMs ?? 'n/a'}ms, later answers ${JSON.stringify(samples.slice(1, 6).map((s) => s.durationMs))}ms`
    )
    expect(withSnapshot.length, 'sampler never saw a wtA snapshot on B2').toBeGreaterThan(0)
    expect(
      samples.length,
      `sampler produced too few samples for a ${steadyStateMs}ms steady-state window`
    ).toBeGreaterThanOrEqual(5)
    // A connect race on the very first call is a harness artefact; an error after B2 has answered
    // once would mean its runtime went away mid-test.
    expect(
      samples.slice(1).filter((sample) => sample.error),
      'listAll sampler hit errors after B2 had already answered'
    ).toEqual([])
    const republished = samples.filter((sample) =>
      sample.editorPaths.some((p) => p.endsWith(INDEX_SUFFIX))
    )
    expect(
      republished,
      `B2 republished src/index.ts in ${republished.length} sample(s) after relaunch`
    ).toEqual([])
    expect(hasEditorTab(await listAll(bClient), wtA, INDEX_SUFFIX)).toBe(false)

    // (d) close finality tail: store, then disk.
    await closeFileById(orcaPage, localId!)
    await expect
      .poll(async () => (await readOpenFileRows(B2.page, INDEX_SUFFIX)).length, {
        timeout: 30_000,
        message: 'B2 kept the restored mirror after A closed the file'
      })
      .toBe(0)
    await soak('restored mirror stays closed', 20_000, 1_000, async () => {
      expect(await readOpenFileRows(B2.page, INDEX_SUFFIX)).toHaveLength(0)
    })
    await expect
      .poll(() => scanPartitions(userDataDir, wtA, INDEX_SUFFIX).length, {
        timeout: 30_000,
        message: 'persisted src/index.ts row was not removed from the profile after close'
      })
      .toBe(0)
  } finally {
    if (live) {
      await live.dispose()
    } else {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
})

test('localhost SSH host-owned files stay published', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const preflight = sshLocalhostPreflight()
  if (!preflight.ok) {
    log(`SKIPPING localhost SSH test: ${preflight.reason}`)
  }
  test.skip(!preflight.ok, preflight.ok ? '' : preflight.reason)
  if (!preflight.ok) {
    return
  }
  test.setTimeout(600_000)
  test.slow()
  void testInfo

  const repo = createSeededTestRepo({ publishPath: false })
  registerPostElectronShutdownCleanup(async () => cleanupTestRepository(repo))
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const aUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const aClient = new RuntimeClient(aUserData, 30_000, null, null)

  const target: SshTargetCreateInput = { ...preflight.target, relayGracePeriodSeconds: 1 }
  const remote = await connectSshTestTarget(orcaPage, target, {
    remotePath: repo,
    displayName: 'Mirror echo SSH'
  }).catch((error: unknown) => {
    throw new Error(
      `Failed to prepare localhost SSH target ${preflight.target.username}@${
        preflight.target.host || preflight.target.configHost
      }:${preflight.target.port}: ${String(error)}`,
      { cause: error }
    )
  })
  log(`SSH worktree ${remote.worktreeId} (repo ${remote.repoId}, target ${remote.targetId})`)

  // (1) opened locally in the SSH-routed worktree
  await openLocalFile(orcaPage, {
    filePath: path.join(repo, 'README.md'),
    relativePath: README_SUFFIX,
    worktreeId: remote.worktreeId,
    language: 'markdown'
  })
  // (2) opened through the CLI socket: exercises the route.kind === 'ssh' stat branch
  const opened = await aClient.call<RuntimeFileOpenResult>('files.open', {
    worktree: `id:${remote.worktreeId}`,
    relativePath: INDEX_SUFFIX
  })
  expect(opened.result.opened).toBe(true)

  for (const suffix of [README_SUFFIX, INDEX_SUFFIX]) {
    await expect
      .poll(
        async () =>
          (await readOpenFileRows(orcaPage, suffix)).filter(
            (row) => row.worktreeId === remote.worktreeId
          ).length,
        { timeout: 30_000, message: `A holds no row for ${suffix} in the SSH worktree` }
      )
      .toBeGreaterThan(0)
    const rows = (await readOpenFileRows(orcaPage, suffix)).filter(
      (row) => row.worktreeId === remote.worktreeId
    )
    log(`SSH rows for ${suffix}: ${JSON.stringify(rows)}`)
    for (const row of rows) {
      expect(
        row.mirroredFromRuntimeSession,
        `${suffix} on an SSH worktree carries the mirror marker`
      ).toBeUndefined()
    }
    await expect
      .poll(async () => hasEditorTab(await listAll(aClient), remote.worktreeId, suffix), {
        timeout: 30_000,
        message: `A's inventory does not list ${suffix} for the SSH worktree (false exclusion)`
      })
      .toBe(true)
  }
})
