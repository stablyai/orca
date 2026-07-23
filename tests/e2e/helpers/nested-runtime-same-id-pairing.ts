import type { Page } from '@stablyai/playwright-test'

import { updateEnvironmentFromPairingCode } from '../../../src/shared/runtime-environment-store'

export type SameIdPairingReplacement = {
  environmentId: string
  previousPairingRevision: number
  nextPairingRevision: number
}

export async function replaceRuntimePairingInPlace(args: {
  environmentId: string
  page: Page
  pairingUrl: string
  userDataDir: string
}): Promise<SameIdPairingReplacement> {
  const previous = await args.page.evaluate((selector) => {
    return window.api.runtimeEnvironments.resolve({ selector })
  }, args.environmentId)
  await args.page.evaluate(async (selector) => {
    await window.api.runtimeEnvironments.disconnect({ selector })
  }, args.environmentId)
  const updated = updateEnvironmentFromPairingCode(args.userDataDir, args.environmentId, {
    pairingCode: args.pairingUrl
  })
  const hydrated = await args.page.evaluate(async (selector) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired desktop store is unavailable during same-ID re-pair')
    }
    const environments = await window.api.runtimeEnvironments.list()
    store.getState().setRuntimeEnvironments(environments)
    if (!(await store.getState().refreshRuntimeEnvironmentStatus(selector))) {
      throw new Error('Same-ID re-paired desktop could not reach the HUB runtime')
    }
    if (!(await store.getState().switchRuntimeEnvironment(selector))) {
      throw new Error('Same-ID re-paired desktop could not select the HUB runtime')
    }
    // Why: same-ID selection is a no-op, so explicitly rehydrate the graph from the replacement transport.
    await store.getState().fetchRepos()
    await store.getState().fetchAllWorktrees()
    await store.getState().fetchWorktreeLineage()
    return window.api.runtimeEnvironments.resolve({ selector })
  }, args.environmentId)
  const previousPairingRevision = previous.pairingRevision ?? previous.createdAt
  const nextPairingRevision = hydrated.pairingRevision ?? hydrated.createdAt
  if (updated.id !== args.environmentId || hydrated.id !== args.environmentId) {
    throw new Error('Same-ID re-pair unexpectedly changed the environment identity')
  }
  if (nextPairingRevision <= previousPairingRevision) {
    throw new Error('Same-ID re-pair did not advance the pairing revision')
  }
  return { environmentId: args.environmentId, previousPairingRevision, nextPairingRevision }
}
