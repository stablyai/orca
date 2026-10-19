/**
 * A phone paired directly with `orca serve` still lists a `terminal.create` terminal after the
 * serve process restarts (an update does this), both in its first tab-stream snapshot and in a
 * tab list. Regression oracle for #26022: the cold-start hydrate used to keep only serve-minted
 * PTYs, so CLI and agent terminals vanished from the phone.
 */
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileClient } from './helpers/paired-mobile-client'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

function sortedPtyIds(ids: (string | null | undefined)[]): string[] {
  return ids.flatMap((id) => (id ? [id] : [])).sort()
}

function terminalPtyIds(snapshot: RuntimeMobileSessionTabsResult): string[] {
  return sortedPtyIds(snapshot.tabs.map((tab) => (tab.type === 'terminal' ? tab.ptyId : null)))
}

async function listedPtyIds(phone: PairedMobileClient, worktreeId: string): Promise<string[]> {
  const listed = await phone.request<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return listed.ok ? terminalPtyIds(listed.result) : [`refused:${listed.error.code}`]
}

test('phone paired with orca serve keeps a terminal.create terminal across a serve restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(120_000)
  const { host, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'host', pinnedServePort: true },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
    expect(worktreeId, 'the phone lists the serve host workspace').not.toBe('')

    // Why both: the bug kept serve-minted PTYs (the phone's own create) and dropped daemon-minted ones.
    const phoneCreated = await phone.call<{ tab: { ptyId?: string | null } }>(
      'session.tabs.createTerminal',
      { worktree: `id:${worktreeId}`, activate: false, select: true, navigation: 'caller' }
    )
    const cliCreated = await host.client.call<{ terminal: { ptyId?: string | null } }>(
      'terminal.create',
      { worktree: `path:${testRepoPath}`, title: 'cli-created' }
    )
    const ptyIds = [phoneCreated.tab.ptyId, cliCreated.result.terminal.ptyId]
    expect(ptyIds.every(Boolean), 'both creates report their PTY').toBe(true)
    const expected = sortedPtyIds(ptyIds)
    await expect.poll(() => listedPtyIds(phone, worktreeId)).toEqual(expected)

    await host.restartServeProcess()

    // The phone's session strip is built from this stream's first snapshot after the cold start.
    let snapshotPtyIds: string[] | null = null
    const streamErrors: string[] = []
    await phone.subscribe<{ type: string } & RuntimeMobileSessionTabsResult>(
      'session.tabs.subscribe',
      { worktree: `id:${worktreeId}` },
      {
        onResponse: (response) => {
          if (!response.ok) {
            streamErrors.push(response.error.code)
          } else if (response.result.type === 'snapshot' && !snapshotPtyIds) {
            snapshotPtyIds = terminalPtyIds(response.result)
          }
        },
        onError: (error) => streamErrors.push(error.message)
      },
      30_000
    )
    await expect
      .poll(() => ({ snapshotPtyIds, streamErrors }))
      .toEqual({ snapshotPtyIds: expected, streamErrors: [] })
    expect(await listedPtyIds(phone, worktreeId)).toEqual(expected)
  } finally {
    await dispose()
  }
})
