import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

// A real windowless serve host must degrade focus-requested terminal creation without refusing for lack of a renderer (#10333).
test('creates a focus-requested terminal against a headless serve host', async ({
  testRepoPath
}) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          worktreeId = listed.result.worktrees[0]?.id ?? ''
          return worktreeId
        },
        { timeout: 30_000 }
      )
      .not.toBe('')

    // Match the RPC sent by remote terminal create --focus.
    const created = await host.client.call<{
      terminal: { handle: string; worktreeId: string; ptyId?: string }
    }>('terminal.create', {
      worktree: `id:${worktreeId}`,
      command: 'echo orca-10333-focus',
      focus: true,
      presentation: 'focused'
    })

    expect(created.result.terminal.handle).toMatch(/^term_/)
    expect(created.result.terminal.worktreeId).toBe(worktreeId)

    // Require a resolvable terminal handle so degraded create cannot pass without a real PTY.
    const listedTerminals = await host.client.call<{
      terminals: { handle: string }[]
    }>('terminal.list', { worktree: `id:${worktreeId}` })
    expect(listedTerminals.result.terminals.map((terminal) => terminal.handle)).toContain(
      created.result.terminal.handle
    )
  } finally {
    await host.dispose()
  }
})
