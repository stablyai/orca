import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

// Why (#10333): a windowless `orca serve` host answered every focus-requested
// create with "No renderer window available", so `terminal create --focus` had
// no workaround. Drive the real RPC a remote CLI sends, against a real serve
// process, so the degrade is proven on the topology that broke.
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

    // Exactly what `orca --environment <remote> terminal create --worktree <wt>
    // --command "echo test" --focus --json` puts on the wire.
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

    // Why: a handle the host cannot resolve back to a live PTY would be a
    // hollow pass — confirm the degraded create really produced a terminal.
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
