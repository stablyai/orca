/**
 * "Use on this computer again" while the host still runs its copy of the project: undo must stop the host's terminals for the project before the panes wake here, so the
 * project's terminal runs in exactly one place. The host is a windowless paired host holding the
 * project under the ids the move gave it; the desktop is a paired client the move journaled.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/wsl-move-undo-host-copy.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'
import { createMovedRepo } from './helpers/wsl-moved-host-profile'
import { wslMoveCutoverFixture } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../src/main/persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'
import { getEnvironmentStorePath } from '../../src/shared/runtime-environment-store-file'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'

const GATE = { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' }

test("undo stops the host's copy first, so the project's terminal runs in one place", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX shell commands')
  // A move, a host terminal start and the undo's reload, each booting a full app.
  test.setTimeout(900_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-undo-host-copy-'))
  const repoPath = realpathSync(createMovedRepo(root))
  const host = await launchHeadlessPairedRuntimeHost({
    pinnedServePort: true,
    withoutBrowser: true,
    // Stands in for the distro's orcad, the only host that serves moved panes' history.
    extraEnv: { ORCA_E2E_WSL_MOVE_DESTINATION: '1' }
  })
  const session = createRestartSession(testInfo, GATE)
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    // This desktop's project before the move: a terminal with history, paused by the move.
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, repoPath)
    await ensureTerminalVisible(launched.page)
    const ptyId = await waitForActivePanePtyId(launched.page)
    await execInTerminal(launched.page, ptyId, 'M=UNDO; seq -f "${M}H-%04g" 1 50')
    await waitForTerminalOutput(launched.page, 'UNDOH-0050', 30_000)
    const slept = await launched.page.evaluate(
      (id) =>
        window.api.runtime.call({ method: 'worktree.sleep', params: { worktree: `id:${id}` } }),
      worktreeId
    )
    expect(slept.ok).toBe(true)
    const repoId = worktreeId.split('::')[0]
    // The WSL host this desktop moved the project to, paired as the move pairs it.
    const environmentId = await launched.page.evaluate(
      async (pairingCode) =>
        (await window.api.runtimeEnvironments.addFromPairingCode({ name: 'Ubuntu', pairingCode }))
          .environment.id,
      host.offer.pairingUrl
    )
    await session.close(launched.app)
    launched = undefined

    // The host holds the project under the ids the move gave it, its copy of the pane running.
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: repoPath,
      kind: 'git'
    })
    await host.restartServeProcess({
      betweenProcesses: () =>
        mutateStoppedProfileState(host.userDataDir, (state) => {
          Object.assign(
            state,
            JSON.parse(JSON.stringify(state).replaceAll(added.result.repo.id, repoId))
          )
        })
    })
    await host.client.call('session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command: 'sleep 600',
      activate: false,
      select: false,
      navigation: 'caller'
    })
    const hostRunning = async (): Promise<number> =>
      (
        await host.client.call<RuntimeTerminalListResult>('terminal.list', {
          worktree: `id:${worktreeId}`
        })
      ).result.terminals.filter((terminal) => terminal.connected).length
    await expect.poll(hostRunning, { timeout: 30_000 }).toBe(1)

    // The move names its host by the WSL environment id; the paired host stands in under it.
    const move = wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: [repoId] })
    const storePath = getEnvironmentStorePath(session.userDataDir)
    writeFileSync(
      storePath,
      readFileSync(storePath, 'utf8').replaceAll(environmentId, move.destinationEnvironmentId)
    )
    seedWslMoveCutover(session.userDataDir, move)
    launched = await session.launch()
    const { page } = launched
    await waitForSessionReady(page)
    const entry = page.getByTestId('wsl-moved-project')
    await expect(entry).toBeVisible({ timeout: 30_000 })
    const reloaded = page.waitForEvent('load', { timeout: 120_000 })
    await entry.getByTestId('wsl-moved-use-here').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Use on this computer' }).click()
    await reloaded
    await waitForSessionReady(page)

    // The host's copy stopped before anything woke here, and the project is back on this computer
    // with its pane slept: opening it (the lifecycle e2e) starts the only copy that runs.
    expect(await hostRunning()).toBe(0)
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.__store!.getState().repos.some((repo) => repo.id === id),
          repoId
        )
      )
      .toBe(true)
    await expect(page.getByTestId('wsl-moved-project')).toHaveCount(0)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
