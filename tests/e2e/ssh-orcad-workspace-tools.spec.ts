/**
 * Workspace tools on an orcad-managed SSH host: Quick Open over a monorepo-sized tree, the host's
 * port scan and an SSH port forward, an image outside the workspace opened from a terminal link, and
 * agent status reported from a remote terminal.
 */
import { expect, test } from './helpers/orca-app'
import { reconnect } from './helpers/orcad-convert-flow'
import { callEnvironment, createPairedHostTerminal } from './helpers/paired-host-terminal'
import { reserveLocalPort } from './helpers/reserve-local-port'
import { openTerminalWorkspaceRootLink } from './helpers/terminal-workspace-root-link'
import {
  echoMarker,
  expectTerminalAnswers,
  launchManagedWorkspace,
  openTerminalTab,
  skipUnlessManagedDockerHost,
  typeInTerminal,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'

skipUnlessManagedDockerHost()
test.skip(process.platform === 'win32', 'The Docker SSH host uses POSIX tooling')

test('Quick Open finds a file in a monorepo-sized managed workspace', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(10 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const repo = quotePosixShell(fixture.host.remoteRepoPath)
    // ~22.6k tracked paths: past the size whose single reply once overflowed the transport (#12547).
    fixture.host.exec!(
      [
        `cd ${repo}`,
        'for d in $(seq 1 226); do mkdir -p packages/pkg-$d/src && (cd packages/pkg-$d/src && ' +
          'touch $(seq -f "module-with-a-long-descriptive-name-%05g.ts" 1 100)); done',
        'touch packages/pkg-200/src/quick-open-needle-target.ts',
        'git add -A',
        'git -c user.email=e2e@test.local -c user.name=e2e commit -q -m "monorepo-sized tree"'
      ].join(' && ')
    )
    const { page } = await launchManagedWorkspace(fixture)
    await page.evaluate(() => window.__store?.getState().openModal('quick-open'))
    const dialog = page.getByRole('dialog', { name: 'Go to file' })
    await expect(dialog).toBeVisible()
    const input = dialog.getByPlaceholder('Go to file...')
    await input.fill('quick-open-needle-target')
    await expect(
      dialog.getByRole('option').filter({ hasText: 'quick-open-needle-target.ts' })
    ).toHaveCount(1, { timeout: 90_000 })
    await input.fill('module-with-a-long-descriptive-name-00042')
    await expect(dialog.getByRole('option').first()).toBeVisible({ timeout: 60_000 })
    await expect(dialog.getByText('Loading files...')).toHaveCount(0)
    await expect(dialog).not.toContainText('Remote Orca runtime closed the connection')
    await page.screenshot({ path: testInfo.outputPath('managed-quick-open.png') })
  })
})

for (const acrossReconnect of [false, true]) {
  test(`a managed host reports its listener, and an SSH forward reaches it${acrossReconnect ? ' across a reconnect' : ''}`, async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
  {}, testInfo) => {
    test.setTimeout(10 * 60_000)
    const remotePort = 7860
    const marker = `ORCA_FORWARD_${Date.now()}`
    const reservation = await reserveLocalPort()
    await withManagedHost(testInfo, async (fixture) => {
      const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
      const script = `require('node:http').createServer((_q, r) => r.end(${JSON.stringify(marker)})).listen(${remotePort}, '127.0.0.1')`
      // Started from the workspace so the scan attributes it to this workspace.
      fixture.host.exec!(
        `cd ${quotePosixShell(fixture.host.remoteRepoPath)} && nohup node -e ${quotePosixShell(script)} >/tmp/orca-http.log 2>&1 < /dev/null &`
      )
      // The scan the Ports panel shows for a workspace on this host.
      await expect
        .poll(
          async () =>
            JSON.stringify(await callEnvironment(page, environmentId, 'workspacePorts.scan', {})),
          { timeout: 60_000, message: 'the managed host never reported the listener' }
        )
        .toContain(`"port":${remotePort}`)

      const localPort = reservation.port
      await reservation.release()
      const forward = await page.evaluate(
        (args) => window.api.ssh.addPortForward({ ...args, remoteHost: '127.0.0.1' }),
        { targetId: seeded.targetId, localPort, remotePort, label: 'managed e2e' }
      )
      const fetchMarker = async (): Promise<string> => {
        try {
          return await (await fetch(`http://127.0.0.1:${localPort}/`)).text()
        } catch (error) {
          return String(error)
        }
      }
      await expect.poll(fetchMarker, { timeout: 30_000 }).toBe(marker)
      let forwardId = forward.id
      if (acrossReconnect) {
        await reconnect(page, seeded.targetId)
        await expect.poll(fetchMarker, { timeout: 60_000 }).toBe(marker)
        // The restored forward is a new entry for the same saved port.
        const restored = await page.evaluate(
          (targetId) => window.api.ssh.listPortForwards({ targetId }),
          seeded.targetId
        )
        forwardId = restored.find((entry) => entry.localPort === localPort)?.id ?? forwardId
      }
      await page.evaluate((id) => window.api.ssh.removePortForward({ id }), forwardId)
      await expect.poll(fetchMarker, { timeout: 30_000 }).not.toBe(marker)
    }).finally(() => reservation.release())
  })
}

test('a terminal link opens an image outside the managed workspace', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(10 * 60_000)
  const imagePath = '/tmp/orca-ssh-external-preview.png'
  const imageBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4AWN8z8DwnwEJMDGgAcICAO2mBAXmO4drAAAAAElFTkSuQmCC'
  await withManagedHost(testInfo, async (fixture) => {
    fixture.host.exec!(
      `printf '%s' ${quotePosixShell(imageBase64)} | base64 -d > ${quotePosixShell(imagePath)}`
    )
    // Why /root: the default folder workspace is /tmp, which would make the image a workspace file.
    const { page, seeded } = await launchManagedWorkspace(fixture, { folderPath: '/root' })
    // A link is only clickable once the shell has printed it, so wait for one that answers.
    await expectTerminalAnswers(page, await openTerminalTab(page, seeded.worktreeId))
    await openTerminalWorkspaceRootLink(page, testInfo, imagePath, 'open')
    const preview = page.locator(`img[alt="${imagePath.split('/').at(-1)}"]`)
    await expect(preview).toBeVisible({ timeout: 30_000 })
    expect(await preview.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(2)
    await expect(page.getByText('Unable to load file', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('managed-external-image.png') })
  })
})

test('a managed terminal reports agent status from hooks and from Pi-style titles', async (// oxlint-disable-next-line no-empty-pattern -- Owns its app launch through a restart session.
{}, testInfo) => {
  test.setTimeout(10 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const tabId = await openTerminalTab(page, seeded.worktreeId)
    await echoMarker(page, tabId, 'HOOK_READY')
    // Backgrounded: a foreground post ends the shell command, which rightly clears the turn.
    const prompt = `orca managed hook ${Date.now()}`
    const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt })
    await typeInTerminal(
      page,
      tabId,
      [
        '( sleep 0.2; curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/codex"',
        '-H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}"',
        '--data-urlencode "paneKey=${ORCA_PANE_KEY}" --data-urlencode "tabId=${ORCA_TAB_ID}"',
        '--data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}"',
        '--data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}"',
        `--data-urlencode ${quotePosixShell(`payload=${payload}`)} >/tmp/orca-hook.log 2>&1 ) &`
      ].join(' ')
    )
    await expect
      .poll(
        () =>
          page.evaluate(
            (prompt) =>
              Object.values(window.__store?.getState().agentStatusByPaneKey ?? {}).some(
                (entry) =>
                  entry.prompt === prompt &&
                  entry.agentType === 'codex' &&
                  entry.state === 'working'
              ),
            prompt
          ),
        { timeout: 30_000, message: 'the host hook never reached the agent status store' }
      )
      .toBe(true)

    // The host classifies agent titles a remote terminal emits.
    const terminal = await createPairedHostTerminal(page, environmentId, seeded.worktreeId, 'bash')
    const status = async (): Promise<unknown> => {
      const result = await callEnvironment(page, environmentId, 'terminal.agentStatus', {
        terminal: terminal.terminal
      })
      return typeof result === 'object' && result !== null && 'agentStatus' in result
        ? result.agentStatus
        : result
    }
    for (const [title, expected] of [
      ['⠋ OMP', 'working'],
      ['OMP ready', 'idle'],
      ['⠋ Pi', 'working']
    ] as const) {
      await callEnvironment(page, environmentId, 'terminal.send', {
        terminal: terminal.terminal,
        text: `printf '\\033]0;${title}\\007'`,
        enter: true
      })
      await expect
        .poll(status, { timeout: 15_000, message: `title ${title}` })
        .toMatchObject({ isRunningAgent: true, status: expected })
    }
  })
})
