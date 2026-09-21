import type { Page } from '@stablyai/playwright-test'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../src/shared/terminal-tab-types'
import { expect, test } from './helpers/orca-app'
import {
  callPairedRuntime,
  waitForPairedClientWorktree
} from './helpers/paired-client-host-session'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import {
  readPaneIdentitySnapshot,
  resolveActiveTabId,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'

/**
 * A desktop app republishes an unmounted terminal tab's layout from its own saved tree, and
 * derives the leaf set from that tree's stable-id leaves. A leaf id that predates the stable-id
 * scheme drops out of the leaf set but stays in the tree, so the tree stopped covering the leaf
 * set exactly — and the publisher used to answer that by discarding the tree and chaining every
 * leaf with a guessed "horizontal", restacking a side-by-side split for every paired client and
 * for the record they all write back. The real direction has to survive the mismatch.
 */

/** Legacy pane id shape: not a stable pane UUID, so it never reaches the published leaf set. */
const LEGACY_LEAF_ID = 'pane:9'

/** Shrinks both the cold-park delay and the hot-retain window. */
const PARK_DELAY_MS = 2_000
const PARK_DELAY_ENV = { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARK_DELAY_MS) }

// Why a fixture option and not `process.env`: a Playwright worker runs many spec files in one
// process, so a module-scope env write outlives this file and shrinks parking for every spec
// that follows it in the same worker.
test.use({ orcaAppExtraEnv: PARK_DELAY_ENV })

function collectLeafIds(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.leafId]
    : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

/** Direction of the split that separates the two leaves, or null if one side holds both. */
function splitDirectionSeparating(
  node: TerminalPaneLayoutNode | null | undefined,
  leafA: string,
  leafB: string
): 'horizontal' | 'vertical' | null {
  if (!node || node.type === 'leaf') {
    return null
  }
  const firstLeaves = new Set(collectLeafIds(node.first))
  const secondLeaves = new Set(collectLeafIds(node.second))
  if (
    (firstLeaves.has(leafA) && secondLeaves.has(leafB)) ||
    (firstLeaves.has(leafB) && secondLeaves.has(leafA))
  ) {
    return node.direction
  }
  return (
    splitDirectionSeparating(node.first, leafA, leafB) ??
    splitDirectionSeparating(node.second, leafA, leafB)
  )
}

function readSavedLayout(page: Page, tabId: string): Promise<TerminalLayoutSnapshot | null> {
  return page.evaluate((id) => window.__store?.getState().terminalLayoutsByTabId[id] ?? null, tabId)
}

type PublishedTerminalSurface = {
  type: string
  parentTabId?: string
  leafId?: string
  parentLayout?: TerminalLayoutSnapshot
}

async function readPublishedTerminalSurfaces(
  client: PairedElectronClient,
  worktreeId: string,
  hostTabId: string
): Promise<PublishedTerminalSurface[]> {
  const snapshot = await callPairedRuntime<{ tabs: PublishedTerminalSurface[] }>(
    client.page,
    client.environmentId,
    'session.tabs.list',
    { worktree: `id:${worktreeId}` }
  )
  return snapshot.tabs.filter((tab) => tab.type === 'terminal' && tab.parentTabId === hostTabId)
}

test('publishes an unmounted split with its real orientation when a legacy leaf lingers in the saved tree', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(360_000)
  const worktreeId = await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Headed host has no active seeded workspace')
  }
  let client: PairedElectronClient | null = null

  try {
    await waitForActiveTerminalManager(orcaPage, 60_000)
    const hostTabId = await resolveActiveTabId(orcaPage)
    if (!hostTabId) {
      throw new Error('Headed host has no active terminal tab')
    }

    // Split right: two panes side by side, the orientation the report is about.
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2, 60_000)
    const panes = await readPaneIdentitySnapshot(orcaPage)
    const leafIds = (panes?.panes ?? []).map((pane) => pane.leafId)
    const [firstLeafId, secondLeafId] = leafIds
    if (leafIds.length !== 2 || !firstLeafId || !secondLeafId) {
      throw new Error(`Expected two split leaves, saw ${JSON.stringify(leafIds)}`)
    }

    await expect
      .poll(
        async () =>
          splitDirectionSeparating(
            (await readSavedLayout(orcaPage, hostTabId))?.root,
            firstLeafId,
            secondLeafId
          ),
        { timeout: 60_000, message: 'host never saved the side-by-side split' }
      )
      .toBe('vertical')

    // Park the tab: a parked tab is republished from the saved tree, not the live DOM.
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, hostTabId, {
      parkDelayMs: PARK_DELAY_MS
    })

    // The drift under test: the saved tree keeps a leaf the stable-id leaf set cannot carry.
    await orcaPage.evaluate(
      ({ tabId, firstLeafId, secondLeafId, legacyLeafId }) => {
        const state = window.__store?.getState()
        const saved = state?.terminalLayoutsByTabId[tabId]
        if (!state || !saved) {
          throw new Error('No saved layout to seed the legacy leaf into')
        }
        state.setTabLayout(tabId, {
          ...saved,
          root: {
            type: 'split',
            direction: 'horizontal',
            first: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: firstLeafId },
              second: { type: 'leaf', leafId: secondLeafId }
            },
            second: { type: 'leaf', leafId: legacyLeafId }
          }
        })
      },
      { tabId: hostTabId, firstLeafId, secondLeafId, legacyLeafId: LEGACY_LEAF_ID }
    )
    // Control: with no lingering leaf the saved tree covers the leaf set and the publisher
    // never reaches the fallback at all, so the assertions below pass for free.
    expect(collectLeafIds((await readSavedLayout(orcaPage, hostTabId))?.root)).toContain(
      LEGACY_LEAF_ID
    )

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    // The observer inherited the same override back when it came from `process.env`; keep it so
    // scoping the write to this file does not also change what the client does.
    client = await launchPairedElectronClient(offer, testInfo, 'legacy-leaf-orientation-observer', {
      extraEnv: PARK_DELAY_ENV
    })
    await waitForPairedClientWorktree(client.page, worktreeId)

    await expect
      .poll(
        async () =>
          (await readPublishedTerminalSurfaces(client!, worktreeId, hostTabId))
            .map((surface) => surface.leafId)
            .filter((leafId): leafId is string => typeof leafId === 'string')
            .sort(),
        {
          timeout: 90_000,
          message: 'host never published both split leaves to the paired client'
        }
      )
      .toEqual(expect.arrayContaining([firstLeafId, secondLeafId].sort()))
    const published = await readPublishedTerminalSurfaces(client, worktreeId, hostTabId)
    // Control: the leaf set really does exclude the leaf the saved tree still carries, so the
    // publisher reached the mismatch path instead of using the tree verbatim.
    expect(published.map((surface) => surface.leafId)).not.toContain(LEGACY_LEAF_ID)
    const publishedRoot = published.find((surface) => surface.parentLayout)?.parentLayout?.root
    expect(splitDirectionSeparating(publishedRoot, firstLeafId, secondLeafId)).toBe('vertical')
  } finally {
    await client?.dispose()
  }
})
