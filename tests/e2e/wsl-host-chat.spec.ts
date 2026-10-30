/**
 * Native chat on a WSL host with a fake WSL transport: the HUB stands in for the distro's orcad and
 * runs the Claude stub. A second desktop adds the "distro" as a host, opens a chat on a project
 * there, then sees the distro stop: chat calls refuse without booting it (E9) and switching back
 * to the workspace boots it so the chat continues.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from './helpers/orca-app'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { callEnvironment } from './helpers/paired-host-terminal'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, test } from './helpers/structured-claude-stub'
import { waitForSessionReady } from './helpers/store'
import {
  createGitProject,
  fakeWslConnects,
  focusProject,
  launchDesktopWithFakeWsl,
  readDistroState,
  RUNNING,
  STOPPED,
  WSL_ENVIRONMENT_ID,
  writeDistros
} from './helpers/wsl-host-fake-desktop'

test.describe('native chat on a WSL host', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('admits, streams, offers Start for a stopped distro, and continues after Start or a focus boot', async ({
    orcaPage: hub,
    claudeStub
  }, testInfo) => {
    // Two Electron apps, a host add and two chat turns.
    test.setTimeout(300_000)
    await waitForSessionReady(hub)
    // The HUB is the distro's orcad: its settings are the host's, so the chat runs its stub.
    await hub.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))
    const offer = await createRuntimeDesktopPairingOffer(hub)
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-chat-fake-'))
    const distrosFile = path.join(fakeDir, 'distros.json')
    const connectLogFile = path.join(fakeDir, 'connects.log')
    writeDistros(distrosFile, RUNNING)
    const desktop = await launchDesktopWithFakeWsl(
      { distros: RUNNING, distrosFile, connectLogFile, pairingCode: offer.pairingUrl },
      testInfo
    )
    const projectPath = createGitProject()
    try {
      const { page } = desktop
      await page.evaluate(async () => {
        const settings = await window.api.settings.set({ experimentalWslHosts: true })
        window.__store?.setState({ settings })
        await window.__store?.getState().updateSettings({
          experimentalNativeChat: true,
          defaultTuiAgent: 'claude'
        })
      })
      const added = await page.evaluate(() =>
        window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
      )
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
      await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', {
        path: projectPath,
        kind: 'git'
      })
      await expect.poll(() => focusProject(page, projectPath), { timeout: 60_000 }).toBeTruthy()

      // Admission: the host, not this desktop, answers whether it can run the chat.
      const askSupport = () =>
        callEnvironment(page, WSL_ENVIRONMENT_ID, 'agentSession.createSupport', {
          worktree: `path:${projectPath}`,
          agent: 'claude'
        })
      expect(await askSupport()).toMatchObject({ supported: true })

      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menu')
        .getByText('Claude', { exact: true })
        .first()
        .click({ timeout: 60_000 })
      const chat = page.locator('[data-native-chat-root="true"]')
      await expect(chat).toBeVisible({ timeout: 60_000 })
      const composer = chat.getByRole('textbox')
      const send = async (text: string): Promise<void> => {
        // Typing before the composer is editable loses keys, notably right after a reconnect.
        await expect(composer).toBeEditable({ timeout: 60_000 })
        await composer.click()
        await page.keyboard.type(text)
        await expect(composer).toContainText(text)
        await chat.getByRole('button', { name: 'Send', exact: true }).click()
      }
      // The transcript only, so the composer still holding the prompt can't stand in for the message.
      const transcript = chat.locator('[data-native-chat-scroll]')
      /** The prompt's message, followed later in the transcript by a stub reply. */
      const expectReplyAfter = async (text: string): Promise<void> => {
        const prompt = transcript.getByText(text, { exact: true }).last()
        await expect(prompt).toBeVisible({ timeout: 60_000 })
        await expect(
          prompt.locator('xpath=following::*[text()="Stub reply."]').first()
        ).toBeVisible({ timeout: 120_000 })
      }
      await send('hello from the desktop')
      await expectReplyAfter('hello from the desktop')
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-streamed.png') })

      // The distro stops: a chat call is a runtime call, so it refuses rather than boot it.
      const stopDistro = async (): Promise<number> => {
        const connects = fakeWslConnects(connectLogFile).length
        writeDistros(distrosFile, STOPPED)
        await expect
          .poll(
            () =>
              askSupport().then(
                () => 'answered',
                (error: unknown) => String(error)
              ),
            { timeout: 30_000 }
          )
          .toContain('Ubuntu was stopped')
        return connects
      }
      const stoppedNotice = chat.getByText('Ubuntu is stopped', { exact: true })
      const start = chat.getByRole('button', { name: 'Start', exact: true })
      const connectsBeforeStart = await stopDistro()
      // The chat names the stopped distro and offers Start instead of a raw error.
      await expect(stoppedNotice).toBeVisible({ timeout: 30_000 })
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-stopped.png') })
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStart)
      await start.click()
      await expect
        .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
        .toBe(connectsBeforeStart + 1)
      await expect(stoppedNotice).toBeHidden({ timeout: 60_000 })
      await send('after Start')
      await expectReplyAfter('after Start')
      // One Start is one connect: a second would rerun the server's launch in the distro.
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStart + 1)
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-after-start.png') })

      const connectsBeforeStop = await stopDistro()
      await expect(stoppedNotice).toBeVisible({ timeout: 30_000 })

      // Switching away and back is the user acting on the host: that boots it and the chat goes on.
      await page.evaluate(() => window.__store?.getState().setActiveWorktree(null))
      // The whole stopped window, up to the focus, booted nothing.
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStop)
      expect(readDistroState(distrosFile)).toBe('stopped')
      await expect.poll(() => focusProject(page, projectPath), { timeout: 30_000 }).toBeTruthy()
      await expect
        .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
        .toBeGreaterThan(connectsBeforeStop)
      await expect(chat).toBeVisible({ timeout: 60_000 })
      await send('after the distro restarted')
      await expectReplyAfter('after the distro restarted')
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-after-boot.png') })
    } finally {
      await desktop.dispose()
      rmSync(fakeDir, { recursive: true, force: true })
      rmSync(projectPath, { recursive: true, force: true })
    }
  })

  test('names the distro when the agent is no longer installed there', async ({
    orcaPage: hub,
    claudeStub
  }, testInfo) => {
    // Two Electron apps, one chat turn and one failed restart.
    test.setTimeout(240_000)
    await waitForSessionReady(hub)
    await hub.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))
    const offer = await createRuntimeDesktopPairingOffer(hub)
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-chat-missing-'))
    const distrosFile = path.join(fakeDir, 'distros.json')
    writeDistros(distrosFile, RUNNING)
    const desktop = await launchDesktopWithFakeWsl(
      { distros: RUNNING, distrosFile, pairingCode: offer.pairingUrl },
      testInfo
    )
    const projectPath = createGitProject()
    try {
      const { page } = desktop
      await page.evaluate(async () => {
        const settings = await window.api.settings.set({ experimentalWslHosts: true })
        window.__store?.setState({ settings })
        await window.__store?.getState().updateSettings({
          experimentalNativeChat: true,
          defaultTuiAgent: 'claude'
        })
      })
      const added = await page.evaluate(() =>
        window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
      )
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
      await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', {
        path: projectPath,
        kind: 'git'
      })
      await expect.poll(() => focusProject(page, projectPath), { timeout: 60_000 }).toBeTruthy()
      // The menu offers only installed agents, so the chat starts while claude is there.
      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menu')
        .getByText('Claude', { exact: true })
        .first()
        .click({ timeout: 60_000 })
      const chat = page.locator('[data-native-chat-root="true"]')
      const composer = chat.getByRole('textbox')
      const send = async (text: string): Promise<void> => {
        await expect(composer).toBeEditable({ timeout: 60_000 })
        await composer.click()
        await page.keyboard.type(text)
        await expect(composer).toContainText(text)
        await chat.getByRole('button', { name: 'Send', exact: true }).click()
      }
      await send('hello')
      await expect(chat.getByText('Stub reply.').first()).toBeVisible({ timeout: 120_000 })

      // Then claude leaves the host (its PATH keeps only the system dirs the stub fixture checked),
      // and the chat's next start has to find it again.
      await hub.evaluate(async () => {
        await window.__store?.getState().updateSettings({
          agentCmdOverrides: {},
          agentDefaultEnv: { claude: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }
        })
      })
      const sessionId = await page.evaluate(
        () =>
          Object.values(window.__store?.getState().unifiedTabsByWorktree ?? {})
            .flat()
            .find((tab) => tab.agentSessionAgent === 'claude')?.entityId ?? null
      )
      expect(sessionId).toBeTruthy()
      await callEnvironment(page, WSL_ENVIRONMENT_ID, 'agentSession.close', { sessionId })
      await send('again')
      // Says where it's missing, not "the computer running this chat".
      await expect(
        chat.getByText(/Claude isn't installed in the WSL distro Ubuntu\./).first()
      ).toBeVisible({ timeout: 120_000 })
      await expect(chat.getByText(/the computer running this chat/)).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-cli-missing.png') })
    } finally {
      await desktop.dispose()
      rmSync(fakeDir, { recursive: true, force: true })
      rmSync(projectPath, { recursive: true, force: true })
    }
  })

  test('holds Send and offers Start when a runtime call, not liveness, finds the distro stopped', async ({
    orcaPage: hub,
    claudeStub
  }, testInfo) => {
    // Two Electron apps and two chat turns around one stop.
    test.setTimeout(240_000)
    await waitForSessionReady(hub)
    await hub.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))
    const offer = await createRuntimeDesktopPairingOffer(hub)
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-chat-parked-'))
    const distrosFile = path.join(fakeDir, 'distros.json')
    const connectLogFile = path.join(fakeDir, 'connects.log')
    writeDistros(distrosFile, RUNNING)
    // The fake reports no stop of its own, so only the runtime call's park can say it.
    const desktop = await launchDesktopWithFakeWsl(
      {
        distros: RUNNING,
        distrosFile,
        connectLogFile,
        pairingCode: offer.pairingUrl,
        stopSilently: true
      },
      testInfo
    )
    const projectPath = createGitProject()
    try {
      const { page } = desktop
      await page.evaluate(async () => {
        const settings = await window.api.settings.set({ experimentalWslHosts: true })
        window.__store?.setState({ settings })
        await window.__store?.getState().updateSettings({
          experimentalNativeChat: true,
          defaultTuiAgent: 'claude'
        })
      })
      const added = await page.evaluate(() =>
        window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
      )
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
      await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', {
        path: projectPath,
        kind: 'git'
      })
      await expect.poll(() => focusProject(page, projectPath), { timeout: 60_000 }).toBeTruthy()
      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menu')
        .getByText('Claude', { exact: true })
        .first()
        .click({ timeout: 60_000 })
      const chat = page.locator('[data-native-chat-root="true"]')
      const composer = chat.getByRole('textbox')
      const sendButton = chat.getByRole('button', { name: 'Send', exact: true })
      const type = async (text: string): Promise<void> => {
        await expect(composer).toBeEditable({ timeout: 60_000 })
        await composer.click()
        await page.keyboard.type(text)
        await expect(composer).toContainText(text)
      }
      const replies = chat.getByText('Stub reply.')
      await type('hello')
      await sendButton.click()
      await expect(replies.first()).toBeVisible({ timeout: 120_000 })

      // The distro stops; a runtime call (as a poll would) finds it stopped and parks the host.
      const connectsBeforeStop = fakeWslConnects(connectLogFile).length
      writeDistros(distrosFile, STOPPED)
      await expect
        .poll(
          () =>
            callEnvironment(page, WSL_ENVIRONMENT_ID, 'agentSession.createSupport', {
              worktree: `path:${projectPath}`,
              agent: 'claude'
            }).then(
              () => 'answered',
              (error: unknown) => String(error)
            ),
          { timeout: 30_000 }
        )
        .toContain('Ubuntu was stopped')
      const stoppedNotice = chat.getByText('Ubuntu is stopped', { exact: true })
      await expect(stoppedNotice).toBeVisible({ timeout: 30_000 })
      // Send waits for Start rather than failing against a stopped distro; while held, the button is
      // named by why it waits, as for any host hold.
      await type('while stopped')
      await expect(
        chat.getByRole('button', { name: 'Start Ubuntu to send.', exact: true })
      ).toBeDisabled()
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-parked.png') })
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStop)
      expect(readDistroState(distrosFile)).toBe('stopped')

      await chat.getByRole('button', { name: 'Start', exact: true }).click()
      await expect
        .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
        .toBeGreaterThan(connectsBeforeStop)
      await expect(stoppedNotice).toBeHidden({ timeout: 60_000 })
      await expect(sendButton).toBeEnabled({ timeout: 60_000 })
      await sendButton.click()
      // The held message goes out after Start and gets its own reply.
      const held = chat
        .locator('[data-native-chat-scroll]')
        .getByText('while stopped', { exact: true })
      await expect(
        held.last().locator('xpath=following::*[text()="Stub reply."]').first()
      ).toBeVisible({ timeout: 120_000 })
    } finally {
      await desktop.dispose()
      rmSync(fakeDir, { recursive: true, force: true })
      rmSync(projectPath, { recursive: true, force: true })
    }
  })
})
