import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, waitForActivePanePtyId } from './helpers/terminal'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { readRemoteTerminalTabs } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { parseAppSshPtyId } from '../../src/shared/ssh-pty-id'

test.skip(process.env.ORCA_E2E_SSH_DOCKER !== '1', 'Requires Docker SSH fixture')
test.skip(process.platform === 'win32', 'Docker SSH fixture requires POSIX tooling')

test('a fresh client adopts the same live SSH shell under its own target', async (// oxlint-disable-next-line no-empty-pattern -- This test owns both Electron profiles.
{}, testInfo) => {
  test.setTimeout(240_000)
  const first = createRestartSession(testInfo)
  const second = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  let target: DockerSshRelayTarget | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    const a = await first.launch()
    firstApp = a.app
    await waitForSessionReady(a.page)
    const ownerA = await connectDockerSshRelayTarget(a.page, target)
    const ptyA = await waitForActivePanePtyId(a.page, 60_000)
    const tabs = await readRemoteTerminalTabs(a.page, ownerA.worktreeId)
    const tabId = tabs.find((tab) => tab.ptyId === ptyA)?.id
    expect(tabId).toBeTruthy()
    const token = `CLIENT_OWNER_${Date.now()}`
    const proof = '/tmp/orca-client-owner-proof'
    const readProof = () => {
      try {
        return execDockerSshRelayTargetCommand(target!, `cat ${proof}`)
      } catch {
        return null
      }
    }
    await focusActiveTerminalInput(a.page)
    await a.page.keyboard.type(
      `export ORCA_CLIENT_OWNER=${token}; printf '%s|%s' "$$" "$ORCA_CLIENT_OWNER" > ${proof}`
    )
    await a.page.keyboard.press('Enter')
    await expect.poll(readProof).toMatch(new RegExp(`^\\d+\\|${token}$`))
    const before = readProof()
    await expect
      .poll(() =>
        a.page.evaluate(
          async ({ targetId, path, tabId }) => {
            const snapshot = await window.api.remoteWorkspace.get({ targetId })
            return snapshot?.session.tabsByWorktreePath[path]?.some(
              (tab) => tab.id === tabId && Boolean(tab.ptyId)
            )
          },
          { targetId: ownerA.targetId, path: DOCKER_SSH_RELAY_REMOTE_REPO_PATH, tabId }
        )
      )
      .toBe(true)

    const b = await second.launch()
    secondApp = b.app
    await waitForSessionReady(b.page)
    const ownerB = await connectDockerSshRelayTarget(b.page, target, { seedInitialTab: false })
    expect(ownerB.targetId).not.toBe(ownerA.targetId)
    await expect
      .poll(() => readRemoteTerminalTabs(b.page, ownerB.worktreeId))
      .toEqual([{ id: tabId, ptyId: expect.any(String) }])
    const ptyB = await waitForActivePanePtyId(b.page, 60_000)
    expect(parseAppSshPtyId(ptyB)).toEqual({
      connectionId: ownerB.targetId,
      relayPtyId: parseAppSshPtyId(ptyA)?.relayPtyId
    })
    execDockerSshRelayTargetCommand(target, `rm ${proof}`)
    await focusActiveTerminalInput(b.page)
    await b.page.keyboard.type(
      `printf '%s|%s' "$$" "$ORCA_CLIENT_OWNER" > ${proof}; printf 'CLIENT_ADOPTED_%s\\n' "$ORCA_CLIENT_OWNER"`
    )
    await b.page.keyboard.press('Enter')
    await expect.poll(readProof).toBe(before)
    await b.page.evaluate((id) => {
      const pane = window.__paneManagers?.get(id!)?.getActivePane?.()
      if (!pane) {
        throw new Error('Adopted pane unavailable')
      }
      pane.terminal.options.screenReaderMode = true
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }, tabId)
    await expect(b.page.locator('.xterm-accessibility-tree')).toContainText(
      `CLIENT_ADOPTED_${token}`
    )
    // The first client remains attached; process identity and shell state prove live adoption.
    expect(await waitForActivePanePtyId(a.page)).toBe(ptyA)
  } finally {
    if (secondApp) {
      await second.close(secondApp)
    }
    if (firstApp) {
      await first.close(firstApp)
    }
    await second.dispose()
    await first.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})
