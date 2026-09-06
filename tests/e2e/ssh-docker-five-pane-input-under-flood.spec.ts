import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  focusActiveTerminalInput,
  focusLastTerminalPane,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { readPaneIdentitySnapshot } from './helpers/terminal-pane-identity'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'

function floodWithInputAcknowledgements(marker: string): string {
  const script = [
    `const marker=${JSON.stringify(marker)}`,
    "const padding='S'.repeat(2048)",
    "let input='', ack='', sequence=0, blocked=false",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { input+=chunk; let end; while((end=input.indexOf('\\n'))>=0) { ack=input.slice(0,end).trim(); input=input.slice(end+1); } })",
    "process.stdout.on('drain', () => { blocked=false })",
    "setInterval(() => { if(!blocked) blocked=!process.stdout.write(marker+':'+(++sequence)+':ACK='+ack+':'+padding+'\\n'); },8)"
  ].join(';')
  return `node -e ${quotePosixShell(script)}`
}

test.describe('five SSH panes under simultaneous output', () => {
  test.skip(process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Requires the Docker SSH target')

  test('each pane acknowledges keyboard input after hiding and reopening the flooding workspace', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(420_000)
    const target = startDockerSshRelayTarget(testInfo)
    registerPostElectronShutdownCleanup(async () => cleanupDockerSshRelayTarget(target))
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await connectDockerSshRelayTarget(orcaPage, target, {
      remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
    })
    await ensureTerminalVisible(orcaPage, 45_000)
    await waitForActiveTerminalManager(orcaPage, 60_000)
    const runId = randomUUID()
    const owners: { leafId: string; ptyId: string; marker: string }[] = []
    for (let index = 0; index < 5; index++) {
      if (index > 0) {
        await splitActiveTerminalPane(orcaPage, 'vertical')
        await focusLastTerminalPane(orcaPage)
      }
      const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)
      const identity = await readPaneIdentitySnapshot(orcaPage)
      expect(identity?.activeLeafId).toBeTruthy()
      const marker = `FLOOD_${runId}_${index}`
      owners.push({ leafId: identity!.activeLeafId!, ptyId, marker })
      await execInTerminal(orcaPage, ptyId, floodWithInputAcknowledgements(marker))
      await waitForTerminalOutput(orcaPage, `${marker}:`, 60_000, 80_000)
    }
    expect(new Set(owners.map((owner) => owner.ptyId)).size).toBe(5)
    const identity = await readPaneIdentitySnapshot(orcaPage)
    expect(identity?.panes).toHaveLength(5)
    const tabId = identity!.tabId

    for (let round = 0; round < 2; round++) {
      await orcaPage.evaluate(() => window.__store!.getState().setActiveView('tasks'))
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeView))
        .toBe('tasks')
      await orcaPage.evaluate(() => window.__store!.getState().setActiveView('terminal'))
      await waitForActiveTerminalManager(orcaPage, 60_000)
      for (const [index, owner] of owners.entries()) {
        await orcaPage.evaluate(
          ({ tabId, leafId }) => {
            const manager = window.__paneManagers!.get(tabId)!
            const paneId = manager.getNumericIdForLeaf(leafId)
            if (paneId == null) {
              throw new Error(`Flood pane ${leafId} did not remount`)
            }
            manager.setActivePane(paneId, { focus: true })
          },
          { tabId, leafId: owner.leafId }
        )
        expect(await waitForActivePanePtyId(orcaPage)).toBe(owner.ptyId)
        await focusActiveTerminalInput(orcaPage)
        const input = `input_${runId}_${round}_${index}`
        await orcaPage.keyboard.type(input)
        await orcaPage.keyboard.press('Enter')
        // The remote process repeats its latest ACK, so flood eviction cannot hide it.
        await waitForTerminalOutput(orcaPage, `:ACK=${input}:`, 30_000, 80_000)
        await waitForTerminalOutput(orcaPage, `${owner.marker}:`, 30_000, 80_000)
      }
    }
  })
})
