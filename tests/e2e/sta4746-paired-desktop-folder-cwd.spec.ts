import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  closeSta4746Tabs,
  probeWorkspaceTerminal,
  STA4746_PROBE,
  type Sta4746Probe
} from './helpers/sta4746-cwd-probe'

test('STA-4746: paired desktop client lands a folder-workspace PTY on the host folder path @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  test.skip(process.platform === 'win32', 'The shell probe is POSIX-only')

  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sta4746-paired-')))
  const folderPath = path.join(parent, 'workspace')
  let client: PairedElectronClient | null = null
  const hostTabIds: string[] = []
  const clientTabIds: string[] = []
  try {
    mkdirSync(folderPath, { recursive: true })

    const hostWorktree = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const id = state?.activeWorktreeId
      const active = state?.allWorktrees().find((candidate) => candidate.id === id)
      if (!active) {
        throw new Error('Headed host did not select its seeded worktree')
      }
      return { id: active.id, path: active.path }
    })

    const folderWorkspaceId = await orcaPage.evaluate(
      async ({ parentPath, folderPath }) => {
        const group = await window.api.projectGroups.create({
          name: `sta4746-${Date.now()}`,
          parentPath,
          createdFrom: 'manual'
        })
        const workspace = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          name: 'sta4746-ws',
          folderPath
        })
        return workspace.id as string
      },
      { parentPath: parent, folderPath }
    )
    const workspaceKey = `folder:${folderWorkspaceId}`

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(offer, testInfo, 'sta4746-client')
    const pairedClient = client
    // Why the exact environment id: `remote:<anything>@@` would also accept a
    // PTY owned by some other runtime this client happens to know about.
    const remoteOwner = new RegExp(`^remote:${pairedClient.environmentId}@@`)

    await expect
      .poll(
        () =>
          pairedClient.page.evaluate(
            (id) =>
              (window.__store?.getState().folderWorkspaces ?? []).some(
                (workspace) => workspace.id === id
              ),
            folderWorkspaceId
          ),
        { timeout: 60_000, message: 'client never mirrored the host folder workspace' }
      )
      .toBe(true)

    const probeOnClient = async (key: string, phase: string): Promise<Sta4746Probe> => {
      const run = await probeWorkspaceTerminal({
        page: pairedClient.page,
        workspaceKey: key,
        phase,
        expectedPtyOwner: remoteOwner,
        suffixCommand: `touch ./${STA4746_PROBE}-${phase}.marker`
      })
      clientTabIds.push(run.tabId)
      return run.probe
    }

    // Primary: the paired CLIENT drives the terminal; the HOST owns the PTY.
    const folderProbe = await probeOnClient(workspaceKey, 'client-folder')
    expect(folderProbe.pwd).toBe(folderPath)
    expect(folderProbe.root).toBe(folderPath)
    expect(folderProbe.wt).toBe(workspaceKey)
    // Independent filesystem signal: the marker landed in the folder path itself.
    await expect
      .poll(() => existsSync(path.join(folderPath, `${STA4746_PROBE}-client-folder.marker`)), {
        timeout: 30_000,
        message: 'client folder-workspace PTY never wrote its marker into the folder path'
      })
      .toBe(true)

    // Control: a normal git worktree over the same paired transport.
    const worktreeProbe = await probeOnClient(hostWorktree.id, 'client-worktree')
    expect(worktreeProbe.wt).toBe(hostWorktree.id)
    expect(worktreeProbe.pwd).toBe(hostWorktree.path)
    expect(worktreeProbe.root).toBe('')

    // Control: local-only on the host itself, same folder workspace.
    const localRun = await probeWorkspaceTerminal({
      page: orcaPage,
      workspaceKey,
      phase: 'host-local-folder',
      expectedPtyOwner: new RegExp(`^folder:${folderWorkspaceId}@@`)
    })
    hostTabIds.push(localRun.tabId)
    expect(localRun.probe.pwd).toBe(folderPath)
    expect(localRun.probe.root).toBe(folderPath)
  } finally {
    await closeSta4746Tabs(orcaPage, hostTabIds)
    if (client) {
      await closeSta4746Tabs(client.page, clientTabIds)
      await client.dispose()
    }
    rmSync(parent, { recursive: true, force: true })
  }
})
