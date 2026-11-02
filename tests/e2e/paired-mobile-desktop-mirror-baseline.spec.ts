/**
 * Phone paired with a desktop that is itself a client of an `orca serve` host.
 *
 * BASELINE, not the goal: today the phone sees only the desktop's own workspaces, because the
 * desktop main process never holds its paired servers' workspaces. The mirror slice (S2) flips the
 * second assertion; update it there instead of deleting it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

test('baseline until S2: phone paired with a desktop lists its local workspace but not its server workspace', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(120_000)
  const serverFolder = testInfo.outputPath('server-folder')
  mkdirSync(serverFolder, { recursive: true })
  writeFileSync(path.join(serverFolder, 'README.md'), 'server workspace\n')

  const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'desktop' },
    testInfo
  )
  try {
    await host.client.call('repo.add', { path: serverFolder, kind: 'folder' })
    await new RuntimeClient(desktop.userDataDir, 5_000).call('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    // Precondition: the desktop window does show the server's workspace.
    await expect
      .poll(
        () =>
          desktop.page.evaluate(
            (folder) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.path === folder) ?? false,
            serverFolder
          ),
        { timeout: 30_000 }
      )
      .toBe(true)

    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const paths = worktrees.map((row) => row.path)
    expect(paths).toContain(testRepoPath)
    // BASELINE: the server's workspace is missing from the phone. S2 flips this to an `expect.poll`
    // with toContain, since the desktop hydrates the server's rows asynchronously.
    expect(paths).not.toContain(serverFolder)
  } finally {
    await dispose()
  }
})
