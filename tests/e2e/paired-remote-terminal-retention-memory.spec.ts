import { test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { runPairedTerminalParkingOracle } from './helpers/paired-terminal-parking-oracle'

test('ordinary-parks paired terminals and restores authoritative host scrollback @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(240_000)
  const seed = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const worktrees = state?.allWorktrees() ?? []
    const active = worktrees.find((worktree) => worktree.id === state?.activeWorktreeId)
    if (!active) {
      throw new Error('Paired retention host has no active seeded worktree')
    }
    return { repoId: active.repoId, worktreeIds: worktrees.map((worktree) => worktree.id) }
  })
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer, {
    terminalParkingDelayMs: 100
  })
  try {
    await runPairedTerminalParkingOracle(client.page, {
      fallbackWorktreeId: seed.worktreeIds[0]!,
      repoId: seed.repoId
    })
  } finally {
    await client.dispose()
  }
})
