import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { expect, test } from './helpers/orca-app'
import { parseSta4746Probe, sta4746ProbeCommand } from './helpers/sta4746-cwd-probe'

type RuntimeTerminalRead = { tail: string[] }

// Why: this is the host-owned half of STA-4746 — the RPC a remote CLI or a
// paired client sends to a windowless `orca serve`. The paired-client half is
// tests/e2e/sta4746-paired-desktop-folder-cwd.spec.ts.
test('STA-4746: folder-workspace terminal on a headless paired host', async () => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The shell probe is POSIX-only')

  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sta4746-')))
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    const folderPath = path.join(parent, 'workspace')
    mkdirSync(folderPath, { recursive: true })
    // Why: a sibling that has folderPath as a prefix, so a substring match
    // could not stand in for the exact-path assertions below.
    mkdirSync(`${folderPath}-decoy`, { recursive: true })

    const group = await host.client.call<{ group: { id: string } }>('projectGroup.create', {
      name: 'sta4746-group',
      parentPath: parent
    })
    const fw = await host.client.call<{ folderWorkspace: { id: string; folderPath: string } }>(
      'folderWorkspace.create',
      { projectGroupId: group.result.group.id, name: 'sta4746-ws', folderPath }
    )
    const folderWorkspaceId = fw.result.folderWorkspace.id
    expect(fw.result.folderWorkspace.folderPath).toBe(folderPath)

    const created = await host.client.call<{
      terminal: { handle: string; worktreeId: string; ptyId?: string }
    }>('terminal.create', { worktree: `folder:${folderWorkspaceId}` })
    const terminal = created.result.terminal
    expect(terminal.worktreeId).toBe(`folder:${folderWorkspaceId}`)
    // Why: pins that the host daemon owns this PTY under the folder scope,
    // rather than a fallback owner satisfying the path assertion by luck.
    expect(terminal.ptyId).toMatch(new RegExp(`^folder:${folderWorkspaceId}@@`))

    const phase = 'headless-folder'
    await host.client.call('terminal.send', {
      terminal: terminal.handle,
      text: sta4746ProbeCommand(phase),
      enter: true
    })

    const readProbe = async (): Promise<Record<string, string> | null> => {
      const read = await host.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
        terminal: terminal.handle,
        limit: 200
      })
      return parseSta4746Probe(read.result.terminal.tail.join('\n'), phase)
    }
    await expect.poll(async () => (await readProbe())?.pwd ?? '', { timeout: 60_000 }).not.toBe('')

    const probe = await readProbe()
    expect(probe?.pwd).toBe(folderPath)
    expect(probe?.root).toBe(folderPath)
    expect(probe?.wt).toBe(`folder:${folderWorkspaceId}`)
  } finally {
    await host.dispose()
    rmSync(parent, { recursive: true, force: true })
  }
})
