/**
 * `session.tabs.listAll` oracle: a runtime's inventory only carries editor tabs its renderer
 * published, so a file tab for a worktree the runtime merely mirrors is exactly "republished".
 */
import type { RuntimeClient } from '../../../src/cli/runtime-client'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-session-contracts'
import { log, sleep } from './editor-mirror-soak'
import { expect } from './orca-app'

export type ListAllResult = { snapshots: RuntimeMobileSessionTabsResult[] }

export async function listAll(client: RuntimeClient, timeoutMs = 15_000): Promise<ListAllResult> {
  return (await client.call<ListAllResult>('session.tabs.listAll', null, { timeoutMs })).result
}

export function findSnapshot(
  inventory: ListAllResult,
  worktreeId: string
): RuntimeMobileSessionTabsResult | undefined {
  return inventory.snapshots.find((snapshot) => snapshot.worktree === worktreeId)
}

/** File paths of every editor-kind tab ('file' | 'markdown') in a snapshot. */
export function editorTabPaths(snapshot: RuntimeMobileSessionTabsResult | undefined): string[] {
  if (!snapshot) {
    return []
  }
  const paths: string[] = []
  for (const tab of snapshot.tabs) {
    if (tab.type === 'file' || tab.type === 'markdown') {
      paths.push(tab.filePath)
    }
  }
  return paths
}

export function hasEditorTab(
  inventory: ListAllResult,
  worktreeId: string,
  suffix: string
): boolean {
  return editorTabPaths(findSnapshot(inventory, worktreeId)).some((p) => p.endsWith(suffix))
}

type ListAllSample = {
  at: number
  /** Wall time of the call (listAll may await an authoritative publication epoch). */
  durationMs: number
  hasSnapshot: boolean
  editorPaths: string[]
  error?: string
}

/** Samples one runtime's inventory for a worktree in the background until stopped. */
export function startListAllSampler(
  client: RuntimeClient,
  worktreeId: string,
  intervalMs: number
): { stop: () => Promise<ListAllSample[]> } {
  let stopped = false
  const samples: ListAllSample[] = []
  const loop = (async (): Promise<void> => {
    while (!stopped) {
      const startedAt = Date.now()
      try {
        const inventory = await listAll(client, 5_000)
        const snapshot = findSnapshot(inventory, worktreeId)
        samples.push({
          at: Date.now(),
          durationMs: Date.now() - startedAt,
          hasSnapshot: snapshot !== undefined,
          editorPaths: editorTabPaths(snapshot)
        })
      } catch (error) {
        samples.push({
          at: Date.now(),
          durationMs: Date.now() - startedAt,
          hasSnapshot: false,
          editorPaths: [],
          error: error instanceof Error ? error.message : String(error)
        })
      }
      await sleep(intervalMs)
    }
  })()
  return {
    stop: async () => {
      stopped = true
      await loop
      return samples
    }
  }
}

/** Requires a snapshot for `worktreeId` (a mirror-only workspace publishes `tabs: []`) before
 *  asserting it has no editor tab for `suffix`. */
export async function expectNoRepublication(
  label: string,
  client: RuntimeClient,
  worktreeId: string,
  suffix: string
): Promise<void> {
  await expect
    .poll(async () => findSnapshot(await listAll(client), worktreeId) !== undefined, {
      timeout: 60_000,
      message: `oracle vacuous (${label}): listAll never contained a snapshot for ${worktreeId}; "no file tab" cannot be asserted`
    })
    .toBe(true)
  const inventory = await listAll(client)
  const snapshot = findSnapshot(inventory, worktreeId)
  log(
    `${label}: ${worktreeId} snapshot tabs=${JSON.stringify(
      snapshot?.tabs.map((tab) => ({ type: tab.type, id: tab.id }))
    )}`
  )
  expect(
    editorTabPaths(snapshot).filter((p) => p.endsWith(suffix)),
    `${label}: republished editor tab for ${suffix} in ${worktreeId}`
  ).toEqual([])
}
