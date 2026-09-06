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
  getTerminalContent,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
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
      await expect
        .poll(() => getTerminalContent(orcaPage, 80_000), { timeout: 60_000 })
        .toMatch(new RegExp(`${marker}:[1-9][0-9]*:ACK=:`))
    }
    expect(new Set(owners.map((owner) => owner.ptyId)).size).toBe(5)
    const identity = await readPaneIdentitySnapshot(orcaPage)
    expect(identity?.panes).toHaveLength(5)
    const tabId = identity!.tabId
    const visibleTerminals = orcaPage.locator('.xterm:visible')
    await expect(visibleTerminals).toHaveCount(5)

    for (let round = 0; round < 2; round++) {
      await orcaPage.evaluate(() => window.__store!.getState().setActiveView('tasks'))
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeView))
        .toBe('tasks')
      await expect(visibleTerminals).toHaveCount(0)
      await orcaPage.evaluate(() => window.__store!.getState().setActiveView('terminal'))
      await expect(visibleTerminals).toHaveCount(5)
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
        const inputTrace = await orcaPage.evaluateHandle((tabId) => {
          const manager = window.__paneManagers!.get(tabId)!
          const entries = manager.getPanes().map((pane) => ({
            ptyId: pane.container.dataset.ptyId,
            data: '',
            focusedBefore: pane.container.contains(document.activeElement)
          }))
          const subscriptions = manager.getPanes().map((pane, index) =>
            pane.terminal.onData((data) => {
              entries[index].data = (entries[index].data + data).slice(-512)
            })
          )
          return {
            entries,
            dispose: () => subscriptions.forEach((subscription) => subscription.dispose())
          }
        }, tabId)
        // The remote process repeats its latest ACK, so flood eviction cannot hide it.
        try {
          await orcaPage.keyboard.type(input)
          await orcaPage.keyboard.press('Enter')
          await expect
            .poll(() => getTerminalContent(orcaPage, 80_000), { timeout: 30_000 })
            .toMatch(new RegExp(`${owner.marker}:[1-9][0-9]*:ACK=${input}:`))
        } catch (error) {
          const panes = await orcaPage.evaluate((tabId) => {
            const manager = window.__paneManagers!.get(tabId)!
            return manager.getPanes().map((pane) => ({
              active: pane === manager.getActivePane(),
              focused: pane.container.contains(document.activeElement),
              cols: pane.terminal.cols,
              rows: pane.terminal.rows,
              output: pane.serializeAddon.serialize().slice(-80_000)
            }))
          }, tabId)
          await testInfo.attach(`flood-input-${round}-${index}`, {
            body: JSON.stringify({
              input,
              owner,
              panes,
              inputEvents: await inputTrace.evaluate((trace) => trace.entries)
            }),
            contentType: 'application/json'
          })
          throw error
        } finally {
          await inputTrace.evaluate((trace) => trace.dispose())
          await inputTrace.dispose()
        }
      }
    }
  })
})
