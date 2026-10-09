/**
 * JOURNEY: real Orca desktops pair to each other, one opens a file, the others see it — and the
 * mirror must never travel back as if a receiver had opened it (#21121).
 *
 * TOPOLOGY: the `orcaPage` app is host A (seeded repo, worktree wtA). Desktop B pairs to A and A
 * pairs back to B, so both directions are live at once — the shape in which a received editor
 * tab, if republished, would bounce back to its origin. The opt-in variant adds C in a
 * A→envB, B→envC, C→envA ring.
 *
 * ORACLES (in order of authority):
 *  - `session.tabs.listAll` on a client's OWN runtime socket: a file tab for a worktree the client
 *    merely mirrors is exactly "republished"; a `tabs: []` snapshot doubles as non-vacuity control.
 *  - The same inventory read over the real pairing (`callPairedRuntime`) as a cross-check.
 *  - Store rows (`openFiles`, `unifiedTabsByWorktree`) and the DOM tab strip.
 *
 * POSITIVE CONTROLS keep "nothing echoed" from being a silent non-subscription: a folder workspace
 * opened on a peer must land as a mirror, and the inventory must hold a wtA snapshot before "no
 * file tab in it" is asserted.
 *
 * Run (after `VITE_EXPOSE_STORE=true pnpm exec electron-vite build --mode e2e && pnpm run build:cli`):
 *   ORCA_BACKGROUND_LAUNCH=1 SKIP_BUILD=1 pnpm exec playwright test \
 *     tests/e2e/paired-editor-mirror-echo-reciprocal.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 * Three-host variant: add ORCA_E2E_MIRROR_THREE_HOSTS=1.
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import type { RuntimeFileOpenResult } from '../../src/shared/runtime-file-contracts'
import {
  addFolderWorkspace,
  CLAUDE_SUFFIX,
  INDEX_SUFFIX,
  knowsFolderWorkspace,
  makeScratchDir,
  pairBack,
  pairClientToHost,
  proveMirrorLands,
  README_SUFFIX
} from './helpers/editor-mirror-peer-setup'
import {
  activateHostWorktreeOnClient,
  closeFileById,
  editorTabLocator,
  isMirrorOf,
  openLocalFile,
  readActiveRuntimeEnvironmentId,
  readActiveWorktreeId,
  readAllWorktreeIds,
  readOpenFileRows,
  readTerminalLayout,
  readUnifiedEditorTabs
} from './helpers/editor-mirror-renderer-store'
import {
  editorTabPaths,
  expectNoRepublication,
  findSnapshot,
  hasEditorTab,
  listAll,
  type ListAllResult
} from './helpers/editor-mirror-session-inventory'
import { log, soak } from './helpers/editor-mirror-soak'
import { expect, test } from './helpers/orca-app'
import { callPairedRuntime } from './helpers/paired-client-host-session'
import {
  createRuntimeDesktopPairingOffer,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { switchToWorktree, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('two hosts reciprocally paired: mirror without echo, close finality', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  const wtA = await waitForActiveWorktree(orcaPage)
  const aUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const aClient = new RuntimeClient(aUserData, 30_000, null, null)
  const scratchDirs: string[] = []

  const B = await pairClientToHost(orcaPage, testInfo, 'B', wtA)
  try {
    const envA = B.environmentId
    const bClient = new RuntimeClient(B.userDataDir, 30_000, null, null)

    // --- Pair back so A also holds B as its active environment (reciprocal topology).
    const offerB = await createRuntimeDesktopPairingOffer(B.page)
    const envB = await pairBack(orcaPage, offerB, 'B')
    log(`envA(on B)=${envA} envB(on A)=${envB}`)
    await expect
      .poll(() => readAllWorktreeIds(orcaPage), {
        timeout: 30_000,
        message: 'A lost its own worktree from the catalog after pairing back to B'
      })
      .toContain(wtA)
    const activeOnA = await readActiveWorktreeId(orcaPage)
    if (activeOnA !== wtA) {
      // Observation, not a mirror-echo defect: the active-env switch is a host-merged focus change.
      log(
        `OBSERVATION: A's active worktree became ${activeOnA} after pair-back; re-selecting ${wtA}`
      )
      await switchToWorktree(orcaPage, wtA)
    }
    expect(await readActiveRuntimeEnvironmentId(orcaPage)).toBe(envB)

    // --- Liveness control: B's own folder file must land on A (A<-B subscribeAll is live).
    const folderB = await proveMirrorLands('folder-on-B', B.page, orcaPage, envB, scratchDirs)
    // addNonGitFolder made the folder active on B; the DOM check below must look at wtA's strip.
    await activateHostWorktreeOnClient(B, wtA)
    await expect.poll(() => readActiveWorktreeId(B.page)).toBe(wtA)

    // --- Terminal guard baseline on A before any frame about wtA can come back from B.
    const terminalBefore = await readTerminalLayout(orcaPage, wtA)
    log(`A terminal layout before: ${JSON.stringify(terminalBefore)}`)

    // --- ACTION: A opens its own file locally.
    const indexPath = path.join(testRepoPath, 'src', 'index.ts')
    await openLocalFile(orcaPage, {
      filePath: indexPath,
      relativePath: INDEX_SUFFIX,
      worktreeId: wtA,
      language: 'typescript'
    })
    const aRows = await readOpenFileRows(orcaPage, INDEX_SUFFIX)
    expect(aRows, 'A should hold exactly one local row right after opening').toHaveLength(1)
    const localId = aRows[0].id
    log(`A local row id=${localId} runtimeEnvironmentId=${String(aRows[0].runtimeEnvironmentId)}`)

    // --- 1. Mirror on B (store, unified tab, DOM).
    await expect
      .poll(
        async () =>
          (await readOpenFileRows(B.page, INDEX_SUFFIX)).filter((row) => isMirrorOf(row, wtA, envA))
            .length,
        { timeout: 60_000, message: 'B never mirrored src/index.ts from A' }
      )
      .toBe(1)
    const bMirrorRows = await readOpenFileRows(B.page, INDEX_SUFFIX)
    log(`B mirror rows: ${JSON.stringify(bMirrorRows)}`)
    const envAHostId = toRuntimeExecutionHostId(envA)
    await expect
      .poll(
        async () =>
          (await readUnifiedEditorTabs(B.page, wtA)).some(
            (tab) =>
              tab.executionHostId === envAHostId &&
              (tab.entityId.endsWith(INDEX_SUFFIX) || tab.label === 'index.ts')
          ),
        { timeout: 30_000, message: `B has no editor unified tab for wtA owned by ${envAHostId}` }
      )
      .toBe(true)
    const bIndexTab = editorTabLocator(B.page, 'index.ts')
    await expect(bIndexTab.first()).toBeVisible({ timeout: 30_000 })
    await expect(bIndexTab, 'B shows more than one index.ts tab').toHaveCount(1)

    // --- 2. No republication by B (wire oracle on B's own socket, then over the real pairing).
    await expectNoRepublication('B listAll', bClient, wtA, INDEX_SUFFIX)
    await soak('B listAll holds no src/index.ts for wtA', 15_000, 1_000, async () => {
      const inventory = await listAll(bClient)
      const snapshot = findSnapshot(inventory, wtA)
      expect(
        snapshot,
        'oracle vacuous: wtA snapshot vanished from B listAll mid-soak'
      ).toBeDefined()
      expect(editorTabPaths(snapshot).filter((p) => p.endsWith(INDEX_SUFFIX))).toEqual([])
    })
    const viaPairing = await callPairedRuntime<ListAllResult>(
      orcaPage,
      envB,
      'session.tabs.listAll',
      null
    )
    expect(
      findSnapshot(viaPairing, wtA),
      'oracle vacuous: B listAll over the pairing has no wtA snapshot'
    ).toBeDefined()
    expect(hasEditorTab(viaPairing, wtA, INDEX_SUFFIX)).toBe(false)

    // --- 3. No echo on A; A's terminals in wtA untouched by B's empty wtA frame.
    await soak('A keeps one local row and its terminals', 15_000, 1_000, async () => {
      const rows = await readOpenFileRows(orcaPage, INDEX_SUFFIX)
      expect(rows, 'A gained a duplicate/echo row for src/index.ts').toHaveLength(1)
      expect(rows[0].id).toBe(localId)
      expect(rows[0].runtimeEnvironmentId, 'A row was re-owned by envB').not.toBe(envB)
      expect(rows[0].mirroredFromRuntimeSession).toBeUndefined()
      const unified = await readUnifiedEditorTabs(orcaPage, wtA)
      expect(
        unified.some(
          (tab) =>
            (tab.entityId === localId || tab.label === 'index.ts') &&
            !tab.executionHostId?.startsWith('runtime:')
        ),
        `A lost its local editor unified tab: ${JSON.stringify(unified)}`
      ).toBe(true)
      expect(await readTerminalLayout(orcaPage, wtA)).toEqual(terminalBefore)
    })
    await expect(editorTabLocator(orcaPage, 'index.ts').first()).toBeVisible()
    await expect(
      editorTabLocator(orcaPage, 'index.ts'),
      'A shows a duplicate index.ts tab'
    ).toHaveCount(1)

    // --- U4 Phase A: host-owned file opened via mobile RPC from B (A's active env is envB — the
    //     most adversarial case for a false exclusion). Assert only what this fix guarantees: no marker,
    //     published in A's inventory, mirrored on B. runtimeEnvironmentId is logged, not asserted.
    const openedFromB = await callPairedRuntime<RuntimeFileOpenResult>(B.page, envA, 'files.open', {
      worktree: `id:${wtA}`,
      relativePath: README_SUFFIX
    })
    expect(openedFromB.opened).toBe(true)
    await expect
      .poll(async () => (await readOpenFileRows(orcaPage, README_SUFFIX)).length, {
        timeout: 30_000,
        message: 'A never opened README.md from the mobile files.open'
      })
      .toBeGreaterThan(0)
    const readmeRowsA = await readOpenFileRows(orcaPage, README_SUFFIX)
    log(`A README.md rows after files.open via pairing: ${JSON.stringify(readmeRowsA)}`)
    for (const row of readmeRowsA) {
      expect(
        row.mirroredFromRuntimeSession,
        'mobile-opened host file carries the mirror marker'
      ).toBeUndefined()
    }
    await expect
      .poll(async () => hasEditorTab(await listAll(aClient), wtA, README_SUFFIX), {
        timeout: 30_000,
        message: 'A did not publish the mobile-opened README.md (false exclusion)'
      })
      .toBe(true)
    await expect
      .poll(
        async () =>
          (await readOpenFileRows(B.page, README_SUFFIX)).some((row) => isMirrorOf(row, wtA, envA)),
        { timeout: 60_000, message: 'B never mirrored the mobile-opened README.md' }
      )
      .toBe(true)
    // Same route once more through the CLI socket, with a distinct file so the two opens are
    // distinguishable in the inventory.
    const openedFromCli = await aClient.call<RuntimeFileOpenResult>('files.open', {
      worktree: `id:${wtA}`,
      relativePath: CLAUDE_SUFFIX
    })
    expect(openedFromCli.result.opened).toBe(true)
    await expect
      .poll(async () => (await readOpenFileRows(orcaPage, CLAUDE_SUFFIX)).length, {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    const claudeRowsA = await readOpenFileRows(orcaPage, CLAUDE_SUFFIX)
    log(`A CLAUDE.md rows after files.open via CLI socket: ${JSON.stringify(claudeRowsA)}`)
    for (const row of claudeRowsA) {
      expect(row.mirroredFromRuntimeSession).toBeUndefined()
    }
    await expect
      .poll(async () => hasEditorTab(await listAll(aClient), wtA, CLAUDE_SUFFIX), {
        timeout: 30_000,
        message: 'A did not publish the CLI-opened CLAUDE.md (false exclusion)'
      })
      .toBe(true)
    await expect
      .poll(
        async () =>
          (await readOpenFileRows(B.page, CLAUDE_SUFFIX)).some((row) => isMirrorOf(row, wtA, envA)),
        { timeout: 60_000, message: 'B never mirrored the CLI-opened CLAUDE.md' }
      )
      .toBe(true)

    // --- U4 Phase B: folder workspace on the HOST A.
    const folderA = makeScratchDir('orca-mirror-echo-folder-on-A-', {
      'notes.md': '# host folder\n'
    })
    scratchDirs.push(folderA)
    const folderAHandle = await addFolderWorkspace(orcaPage, folderA)
    log(
      `A folder workspace ${folderAHandle.worktreeId}; ${folderAHandle.terminalTabCount} terminal tab(s) auto-created (accepted)`
    )
    // addNonGitFolder made the folder active on A; keep wtA as the active worktree for later DOM checks.
    await switchToWorktree(orcaPage, wtA)
    const notesPath = path.join(folderA, 'notes.md')
    await openLocalFile(orcaPage, {
      filePath: notesPath,
      relativePath: 'notes.md',
      worktreeId: folderAHandle.worktreeId,
      language: 'markdown'
    })
    await expect
      .poll(
        async () => hasEditorTab(await listAll(aClient), folderAHandle.worktreeId, 'notes.md'),
        {
          timeout: 30_000,
          message: `A did not publish its own folder workspace file under ${folderAHandle.worktreeId}`
        }
      )
      .toBe(true)
    await expect
      .poll(
        async () =>
          (await readOpenFileRows(B.page, 'notes.md')).some((row) =>
            isMirrorOf(row, folderAHandle.worktreeId, envA)
          ),
        { timeout: 60_000, message: 'B never mirrored the host folder file notes.md' }
      )
      .toBe(true)
    // Publication skips folder keys absent from the publisher's folderWorkspaces, so the vacuity
    // guard for wtF is conditional on B knowing the folder at all.
    const bKnowsFolderA = await knowsFolderWorkspace(B.page, folderAHandle.worktreeId)
    const folderSnapshotOnB = findSnapshot(await listAll(bClient), folderAHandle.worktreeId)
    if (bKnowsFolderA) {
      expect(
        folderSnapshotOnB,
        'oracle vacuous: B knows the host folder workspace but publishes no snapshot for it'
      ).toBeDefined()
    } else {
      log(
        `B.folderWorkspaces does not list ${folderAHandle.worktreeId}; the no-echo check for the folder key is ${
          folderSnapshotOnB
            ? 'non-vacuous anyway (snapshot present)'
            : 'vacuous on the listAll oracle'
        }`
      )
    }
    expect(editorTabPaths(folderSnapshotOnB).filter((p) => p.endsWith('notes.md'))).toEqual([])
    const notesRowsA = await readOpenFileRows(orcaPage, 'notes.md')
    expect(notesRowsA, 'A gained an echo row for its folder file').toHaveLength(1)
    expect(notesRowsA[0].runtimeEnvironmentId).not.toBe(envB)
    // The B-side folder control from earlier is the client-side folder case: no echo back to B.
    expect(
      (await readOpenFileRows(B.page, 'control.md')).filter(
        (row) => row.worktreeId === folderB.worktreeId
      ),
      'B gained an echo row for its own folder file'
    ).toHaveLength(1)

    // --- 4. Close finality.
    await closeFileById(orcaPage, localId)
    await expect
      .poll(async () => (await readOpenFileRows(B.page, INDEX_SUFFIX)).length, {
        timeout: 30_000,
        message: "B's mirror of src/index.ts did not disappear after A closed it"
      })
      .toBe(0)
    await expect(bIndexTab).toHaveCount(0, { timeout: 30_000 })
    await expect
      .poll(async () => hasEditorTab(await listAll(aClient), wtA, INDEX_SUFFIX), {
        timeout: 30_000,
        message: "A's inventory still lists src/index.ts after close"
      })
      .toBe(false)
    await soak('closed file stays closed on both hosts', 30_000, 1_000, async () => {
      expect(await readOpenFileRows(B.page, INDEX_SUFFIX), 'B regrew the mirror').toHaveLength(0)
      expect(await readOpenFileRows(orcaPage, INDEX_SUFFIX), 'A regrew the row').toHaveLength(0)
      expect(await readTerminalLayout(orcaPage, wtA)).toEqual(terminalBefore)
    })
  } finally {
    await B.dispose()
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('three hosts: A→envB, B→envC, C→envA each mirror exactly one peer inventory without echo', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  test.skip(
    process.env.ORCA_E2E_MIRROR_THREE_HOSTS !== '1',
    'Set ORCA_E2E_MIRROR_THREE_HOSTS=1 to run the three-Electron-tree variant.'
  )
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  const wtA = await waitForActiveWorktree(orcaPage)
  const aUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const aClient = new RuntimeClient(aUserData, 30_000, null, null)
  const scratchDirs: string[] = []

  // Fresh (rotated) offers per client: pairClientToHost mints one each time.
  const B = await pairClientToHost(orcaPage, testInfo, 'B', wtA)
  let C: PairedElectronClient | null = null
  try {
    C = await pairClientToHost(orcaPage, testInfo, 'C', wtA)
    // Why: a const alias keeps the narrowing inside the poll/soak closures below.
    const c: PairedElectronClient = C
    const envAonB = B.environmentId
    const envAonC = c.environmentId
    const bClient = new RuntimeClient(B.userDataDir, 30_000, null, null)
    const cClient = new RuntimeClient(c.userDataDir, 30_000, null, null)

    // Active-environment assignment: subscribeAll follows a client's single active env, so each
    // host mirrors exactly one peer's whole inventory. A→envB, B→envC, C→envA.
    const envBonA = await pairBack(orcaPage, await createRuntimeDesktopPairingOffer(B.page), 'B')
    const envConB = await pairBack(B.page, await createRuntimeDesktopPairingOffer(c.page), 'C')
    // B's active env is now envC; keep wtA active on B under A's owner so A's frames still reach
    // B through the active-worktree path.
    await activateHostWorktreeOnClient(B, wtA)
    log(
      `assignment: A active=${envBonA} (B) | B active=${envConB} (C), wtA owner ${envAonB} (A) | C active=${envAonC} (A)`
    )
    expect(await readActiveRuntimeEnvironmentId(orcaPage)).toBe(envBonA)
    expect(await readActiveRuntimeEnvironmentId(B.page)).toBe(envConB)
    expect(await readActiveRuntimeEnvironmentId(c.page)).toBe(envAonC)
    await expect.poll(() => readAllWorktreeIds(orcaPage)).toContain(wtA)
    if ((await readActiveWorktreeId(orcaPage)) !== wtA) {
      log('OBSERVATION: A active worktree drifted after pair-back; re-selecting wtA')
      await switchToWorktree(orcaPage, wtA)
    }

    const terminalBefore = await readTerminalLayout(orcaPage, wtA)

    // Direction A→C: C mirrors A's full inventory.
    const indexPath = path.join(testRepoPath, 'src', 'index.ts')
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
          (await readOpenFileRows(c.page, INDEX_SUFFIX)).filter((row) =>
            isMirrorOf(row, wtA, envAonC)
          ).length,
        { timeout: 60_000, message: 'C (active env = A) never mirrored src/index.ts' }
      )
      .toBe(1)
    await expect(editorTabLocator(c.page, 'index.ts').first()).toBeVisible({ timeout: 30_000 })
    await expectNoRepublication('C listAll', cClient, wtA, INDEX_SUFFIX)
    // B receives wtA through the active-worktree path (owner envA on B); log what it holds.
    log(`B rows for src/index.ts: ${JSON.stringify(await readOpenFileRows(B.page, INDEX_SUFFIX))}`)
    await expectNoRepublication('B listAll', bClient, wtA, INDEX_SUFFIX)

    // Direction C→B: C's own folder file lands on B (B's active env is C).
    const folderC = await proveMirrorLands('folder-on-C', c.page, B.page, envConB, scratchDirs)
    await activateHostWorktreeOnClient(c, wtA)
    const folderCSnapshotOnB = findSnapshot(await listAll(bClient), folderC.worktreeId)
    if (await knowsFolderWorkspace(B.page, folderC.worktreeId)) {
      expect(
        folderCSnapshotOnB,
        'oracle vacuous: B knows C folder but publishes nothing'
      ).toBeDefined()
    } else {
      log(`B.folderWorkspaces lacks ${folderC.worktreeId}; folder no-echo check on B is store-only`)
    }
    expect(editorTabPaths(folderCSnapshotOnB).filter((p) => p.endsWith('control.md'))).toEqual([])

    // Direction B→A: B's own folder file lands on A (A's active env is B).
    const folderB = await proveMirrorLands('folder-on-B', B.page, orcaPage, envBonA, scratchDirs)
    await activateHostWorktreeOnClient(B, wtA)
    const folderBSnapshotOnA = findSnapshot(await listAll(aClient), folderB.worktreeId)
    if (await knowsFolderWorkspace(orcaPage, folderB.worktreeId)) {
      expect(
        folderBSnapshotOnA,
        'oracle vacuous: A knows B folder but publishes nothing'
      ).toBeDefined()
    } else {
      log(`A.folderWorkspaces lacks ${folderB.worktreeId}; folder no-echo check on A is store-only`)
    }
    expect(editorTabPaths(folderBSnapshotOnA).filter((p) => p.endsWith('control.md'))).toEqual([])

    // A never gains an echo row for its own file from any peer; terminals untouched.
    await soak('A holds one local src/index.ts row across three hosts', 15_000, 1_000, async () => {
      const rows = await readOpenFileRows(orcaPage, INDEX_SUFFIX)
      expect(rows, `A rows: ${JSON.stringify(rows)}`).toHaveLength(1)
      expect(rows[0].id).toBe(localId)
      expect(rows[0].mirroredFromRuntimeSession).toBeUndefined()
      expect([envBonA, envConB, envAonB, envAonC]).not.toContain(rows[0].runtimeEnvironmentId)
      for (const row of await readOpenFileRows(B.page, INDEX_SUFFIX)) {
        expect(
          row.mirroredFromRuntimeSession,
          `B holds an unmarked src/index.ts row: ${row.id}`
        ).toBe(true)
      }
      for (const row of await readOpenFileRows(c.page, INDEX_SUFFIX)) {
        expect(
          row.mirroredFromRuntimeSession,
          `C holds an unmarked src/index.ts row: ${row.id}`
        ).toBe(true)
      }
      expect(await readTerminalLayout(orcaPage, wtA)).toEqual(terminalBefore)
    })

    // Close finality across both mirrors.
    await closeFileById(orcaPage, localId!)
    for (const [name, page] of [
      ['C', c.page],
      ['B', B.page]
    ] as const) {
      await expect
        .poll(async () => (await readOpenFileRows(page, INDEX_SUFFIX)).length, {
          timeout: 30_000,
          message: `${name} kept its src/index.ts mirror after A closed the file`
        })
        .toBe(0)
    }
    await soak('closed file stays closed on A, B and C', 20_000, 1_000, async () => {
      expect(await readOpenFileRows(orcaPage, INDEX_SUFFIX)).toHaveLength(0)
      expect(await readOpenFileRows(B.page, INDEX_SUFFIX)).toHaveLength(0)
      expect(await readOpenFileRows(c.page, INDEX_SUFFIX)).toHaveLength(0)
    })
  } finally {
    await C?.dispose()
    await B.dispose()
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
