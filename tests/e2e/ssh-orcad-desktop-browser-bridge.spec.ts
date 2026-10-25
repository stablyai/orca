// #29145: the managed SSH host’s real CLI may create/navigate/open desktop browser tabs only while its control setting is enabled.
// Require remote-only origin egress through the host and immediate named refusal when the setting turns off.
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshHostTarget,
  DOCKER_SSH_HOST_REMOTE_REPO_PATH,
  execDockerSshHostTargetCommand,
  startDockerSshHostTarget,
  type DockerSshHostTarget
} from './helpers/docker-ssh-host-target'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import {
  readSshRemoteOnlyRequests,
  SSH_REMOTE_ONLY_ORIGIN,
  startSshRemoteOnlyBrowserFixture
} from './helpers/ssh-remote-only-browser-fixture'
import { convertAndRetain } from './helpers/orcad-convert-flow'
import {
  activateManagedWorkspace,
  expectPaneText,
  managedEnvironmentId,
  openTerminalTab,
  ORCAD_TEMPLATE,
  skipUnlessManagedDockerHost,
  typeInTerminal
} from './helpers/orcad-managed-workspace'
import { DESKTOP_BROWSER_BRIDGE_SETTING_LABEL } from '../../src/shared/desktop-browser-bridge-protocol'

skipUnlessManagedDockerHost()

const CliResult = z.object({
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
})
type CliResult = z.infer<typeof CliResult>

let step = 0

/** Runs an `orca` command in the host's terminal, as an agent there would, and reads its JSON. */
async function hostCli(
  page: Page,
  target: DockerSshHostTarget,
  tabId: string,
  command: string
): Promise<CliResult> {
  step += 1
  const out = `/tmp/bridge-cli-${step}.json`
  const marker = `BRIDGE_${step}_DONE`
  // Split so the typed line never contains the marker the wait looks for.
  await typeInTerminal(
    page,
    tabId,
    `${command} --json > ${out} 2>&1; printf '%s_%s\\n' BRIDGE_${step} DONE`
  )
  await expectPaneText(page, tabId, marker, 90_000)
  return CliResult.parse(JSON.parse(execDockerSshHostTargetCommand(target, `cat ${out}`)))
}

/** Retries until the desktop has attached its bridge, since the attach follows the setting change. */
async function hostCliUntilOk(
  page: Page,
  target: DockerSshHostTarget,
  tabId: string,
  command: string
): Promise<CliResult> {
  const results: CliResult[] = []
  try {
    await expect
      .poll(
        async () => {
          const result = await hostCli(page, target, tabId, command)
          results.push(result)
          return result.ok
        },
        { timeout: 120_000, intervals: [2_000], message: 'the host CLI never reached the desktop' }
      )
      .toBe(true)
  } catch (error) {
    throw new Error(`${String(error)}\nlast CLI result: ${JSON.stringify(results.at(-1))}`)
  }
  return results.at(-1)!
}

function setRemoteCliControl(page: Page, targetId: string, enabled: boolean): Promise<unknown> {
  return page.evaluate(
    ({ targetId, enabled }) =>
      window.api.ssh.updateTarget({ id: targetId, updates: { allowRemoteCliControl: enabled } }),
    { targetId, enabled }
  )
}

function browserTabUrls(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    return (state?.browserTabsByWorktree[id] ?? []).flatMap((tab) =>
      (state?.browserPagesByWorkspace[tab.id] ?? []).map((entry) => entry.url)
    )
  }, worktreeId)
}

test('a managed SSH host drives the desktop browser by default until its CLI control setting is turned off', async (// oxlint-disable-next-line no-empty-pattern -- Owns app launch.
{}, testInfo) => {
  test.setTimeout(8 * 60_000)
  const target = startDockerSshHostTarget(testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE! })
  let app: ElectronApplication | null = null
  try {
    startSshRemoteOnlyBrowserFixture(target)
    // The first launch only creates the profile the SSH host is saved into.
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(first.app)
    app = null
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      {
        label: `desktop browser bridge E2E ${Date.now()}`,
        host: target.host,
        port: target.port,
        username: 'root',
        identityFile: target.identityFile,
        identitiesOnly: true,
        relayGracePeriodSeconds: 1
      },
      { repoPath: DOCKER_SSH_HOST_REMOTE_REPO_PATH, folderPath: '/tmp' }
    )
    const launched = await session.launch()
    app = launched.app
    forwardElectronProcessLogs(app, testInfo)
    const page = launched.page
    await waitForSessionReady(page)
    await convertAndRetain(page, session.userDataDir, seeded)
    const environmentId = await managedEnvironmentId(page, seeded.targetId)
    await activateManagedWorkspace(page, seeded.worktreeId, environmentId)
    const tabId = await openTerminalTab(page, seeded.worktreeId)

    // No saved value: on by default.
    const createdUrl = `${SSH_REMOTE_ONLY_ORIGIN}/echo/bridge-created`
    const created = await hostCliUntilOk(page, target, tabId, `orca tab create --url ${createdUrl}`)
    const browserPageId = String(created.result?.browserPageId ?? '')
    expect(browserPageId).not.toBe('')
    await expect
      .poll(() => browserTabUrls(page, seeded.worktreeId), { timeout: 30_000 })
      .toContain(createdUrl)
    // Only the SSH host resolves this origin, so the request proves the desktop page egressed there.
    await expect
      .poll(() => readSshRemoteOnlyRequests(target).map((request) => request.path), {
        timeout: 60_000,
        message: 'the desktop tab the host opened never loaded through the host'
      })
      .toContain('/echo/bridge-created')
    // Like an agent: navigate the tab it opened, then read it back.
    const navigatedUrl = `${SSH_REMOTE_ONLY_ORIGIN}/echo/bridge-navigated`
    await hostCliUntilOk(
      page,
      target,
      tabId,
      `orca goto --url ${navigatedUrl} --page ${browserPageId}`
    )
    await expect
      .poll(() => readSshRemoteOnlyRequests(target).map((request) => request.path), {
        timeout: 60_000,
        message: 'the desktop tab the host drove never loaded through the host'
      })
      .toContain('/echo/bridge-navigated')
    const snapshot = await hostCliUntilOk(
      page,
      target,
      tabId,
      `orca snapshot --page ${browserPageId}`
    )
    expect(JSON.stringify(snapshot.result)).toContain('cookie:')
    const listed = await hostCli(page, target, tabId, 'orca tab list')
    expect(listed.ok).toBe(true)
    expect(JSON.stringify(listed.result)).toContain(browserPageId)
    // `orca open-url` reaches the desktop the same way, as a tab in the host's workspace.
    const openedUrl = `${SSH_REMOTE_ONLY_ORIGIN}/echo/bridge-open-url`
    const opened = await hostCliUntilOk(page, target, tabId, `orca open-url --url ${openedUrl}`)
    const openedPageId = String(opened.result?.browserPageId ?? '')
    expect(openedPageId).not.toBe('')
    await expect
      .poll(() => browserTabUrls(page, seeded.worktreeId), { timeout: 30_000 })
      .toContain(openedUrl)
    await expect
      .poll(() => readSshRemoteOnlyRequests(target).map((request) => request.path), {
        timeout: 60_000,
        message: 'the desktop tab open-url opened never loaded through the host'
      })
      .toContain('/echo/bridge-open-url')
    expect((await hostCli(page, target, tabId, `orca tab close --page ${openedPageId}`)).ok).toBe(
      true
    )
    await page.screenshot({ path: testInfo.outputPath('desktop-browser-bridge-on.png') })
    // A desktop file is never reachable, even through a tab the host may drive.
    const fileRead = await hostCli(
      page,
      target,
      tabId,
      `orca goto --url file:///etc/hosts --page ${browserPageId}`
    )
    expect(fileRead.error?.code).toBe('invalid_argument')
    const closed = await hostCli(page, target, tabId, `orca tab close --page ${browserPageId}`)
    expect(closed.ok).toBe(true)
    await expect
      .poll(() => browserTabUrls(page, seeded.worktreeId), { timeout: 30_000 })
      .not.toContain(navigatedUrl)

    // Explicitly off: the bridge detaches at once and the host is refused with the setting's name.
    await setRemoteCliControl(page, seeded.targetId, false)
    await expect
      .poll(async () => (await hostCli(page, target, tabId, 'orca tab list')).error?.code ?? 'ok', {
        timeout: 60_000,
        intervals: [1_000]
      })
      .toBe('desktop_browser_bridge_unavailable')
    const refused = await hostCli(page, target, tabId, 'orca tab list')
    expect(refused.error?.message).toContain(DESKTOP_BROWSER_BRIDGE_SETTING_LABEL)
    // open-url names the same setting, not a desktop that is "offline".
    const openRefused = await hostCli(page, target, tabId, `orca open-url --url ${openedUrl}`)
    expect(openRefused.error?.code).toBe('desktop_browser_bridge_unavailable')
    expect(openRefused.error?.message).toContain(DESKTOP_BROWSER_BRIDGE_SETTING_LABEL)
  } finally {
    try {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    } finally {
      cleanupDockerSshHostTarget(target)
    }
  }
})
