/**
 * Seeds the divergence STA-3077 is about: a live remote PTY whose lease names a
 * pane that no durable session holds.
 *
 * Why seeded and not induced: the field induction is "close a pane while the
 * link is down and hope `pty:kill` fails". It does not — once the severed
 * transport tears the SSH providers down, `pty:kill` takes its tombstone branch
 * and terminates the lease, so reattach never fans out over it and any oracle
 * downstream passes vacuously. Here the PTY is spawned against a leaf that
 * never becomes a pane, and the durable pane record the spawn minted is rolled
 * back, so the precondition holds by construction with no race in it.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { readDurablePaneBindings } from './remote-pane-durable-session'

export type UnboundRemotePtyLease = {
  /** Leaf the lease names. No pane, in either partition, ever claims it. */
  leafId: string
  /** App-scoped PTY id the spawn returned. */
  ptyId: string
}

type DurableWorkspaceSession = Record<string, unknown>

async function readDurableWorkspaceSession(
  page: Page,
  hostId: string
): Promise<DurableWorkspaceSession> {
  const session = await page.evaluate(
    async (hostId) => (await window.api.session.get(hostId)) as DurableWorkspaceSession | null,
    hostId
  )
  if (!session) {
    throw new Error(`No durable workspace session for ${hostId}`)
  }
  return session
}

/**
 * Full-partition replace, the same shape the renderer's own snapshot write uses.
 * That is deliberate: it is how a durable pane record actually disappears in the
 * field, and it leaves the lease and the remote shell untouched.
 */
async function restoreDurableWorkspaceSession(
  page: Page,
  hostId: string,
  session: DurableWorkspaceSession
): Promise<void> {
  await page.evaluate(
    async ({ hostId, session }) => {
      await window.api.session.set(session as never, hostId)
    },
    { hostId, session }
  )
}

export async function seedUnboundRemotePtyLease(
  page: Page,
  args: {
    targetId: string
    hostId: string
    worktreeId: string
    tabId: string
    leafId: string
    cols?: number
    rows?: number
  }
): Promise<UnboundRemotePtyLease> {
  // Captured before the spawn so the rollback restores a layout that provably
  // predates the leaf, rather than one edited to look like it does.
  const sessionBeforeSpawn = await readDurableWorkspaceSession(page, args.hostId)
  const ptyId = await page.evaluate(
    async ({ targetId, worktreeId, tabId, leafId, cols, rows }) => {
      const result = await window.api.pty.spawn({
        cols: cols ?? 80,
        rows: rows ?? 24,
        cwdFallback: 'worktree',
        connectionId: targetId,
        worktreeId,
        tabId,
        leafId
      })
      return result.id
    },
    {
      targetId: args.targetId,
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      leafId: args.leafId,
      cols: args.cols ?? 80,
      rows: args.rows ?? 24
    }
  )
  await restoreDurableWorkspaceSession(page, args.hostId, sessionBeforeSpawn)
  await expect
    .poll(
      async () =>
        (await readDurablePaneBindings(page, args.hostId, args.worktreeId)).filter((binding) =>
          binding.includes(args.leafId)
        ).length,
      {
        timeout: 30_000,
        message: 'a durable partition still named the seeded leaf after the rollback'
      }
    )
    .toBe(0)
  return { leafId: args.leafId, ptyId }
}
