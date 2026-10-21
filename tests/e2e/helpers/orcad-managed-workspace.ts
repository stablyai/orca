/**
 * A repository workspace on an orcad-managed Docker SSH host, reached the way users reach one:
 * a saved SSH profile whose first connect deploys the managed server. Plus the terminal moves the
 * managed-host journey specs share, driven through the tab bar and the keyboard.
 */
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './orca-app'
import { createRestartSession } from './orca-restart'
import { startOrcadConvertHost, type OrcadConvertHost } from './orcad-convert-host'
import { seedRelayEraProfile, type RelayEraProfile } from './orcad-upgrade-profile'
import { convertAndRetain } from './orcad-convert-flow'
import { readPairedPaneContent } from './paired-host-terminal'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './store'
import { dismissTransientAnnouncement } from './ssh-config-host-picker'
import { focusActiveTerminalInput } from './terminal'
import { toRuntimeExecutionHostId } from '../../../src/shared/execution-host'

export const ORCAD_TEMPLATE = process.env.ORCA_E2E_ORCAD_CONVERT_TEMPLATE

/** Skips the calling spec file unless the Docker SSH host and the orcad template are available. */
export function skipUnlessManagedDockerHost(): void {
  test.skip(
    !ORCAD_TEMPLATE || process.env.ORCA_E2E_SSH_DOCKER !== '1',
    'Needs Docker and server template'
  )
}

export type ManagedHostFixture = {
  host: OrcadConvertHost
  session: ReturnType<typeof createRestartSession>
  /** Set by the body to whichever launch is live, so teardown closes it. */
  app: ElectronApplication | null
}

/** A fresh Docker SSH host and profile for `body`, torn down whatever it throws. */
export async function withManagedHost(
  testInfo: TestInfo,
  body: (fixture: ManagedHostFixture) => Promise<void>
): Promise<void> {
  const host = startOrcadConvertHost('docker', testInfo)
  const session = createRestartSession(testInfo, { ORCA_ORCAD_TEMPLATE_PATH: ORCAD_TEMPLATE! })
  const fixture: ManagedHostFixture = { host, session, app: null }
  try {
    await body(fixture)
  } finally {
    try {
      await session.dispose(fixture.app ?? undefined)
    } finally {
      host.cleanup()
    }
  }
}

export type ManagedWorkspace = {
  app: ElectronApplication
  page: Page
  seeded: RelayEraProfile
  environmentId: string
}

export type ManagedProfileOptions = {
  /** Overrides the host's repository, e.g. a same-path desktop collision. */
  repoPath?: string
  /** Overrides the host's folder workspace, e.g. to keep /tmp outside every workspace. */
  folderPath?: string
  /** Passed through to the relay-era seed, e.g. an unsaved editor draft. */
  seed?: Pick<NonNullable<Parameters<typeof seedRelayEraProfile>[3]>, 'draftContent'>
  /** Runs on the profile-creating launch, before the SSH profile is seeded. */
  beforeSeed?: (page: Page) => Promise<void>
  /** Runs as soon as the converting launch starts, before the session is ready. */
  onLaunch?: (page: Page, seeded: RelayEraProfile) => void | Promise<void>
}

/** Seeds a relay-era profile and converts it; each launch is recorded on `fixture` for teardown. */
export async function launchConvertedProfile(
  fixture: ManagedHostFixture,
  options: ManagedProfileOptions = {}
): Promise<ManagedWorkspace> {
  const { host, session } = fixture
  // The first launch only creates the profile the saved SSH host is written into.
  const first = await session.launch()
  fixture.app = first.app
  await waitForSessionReady(first.page)
  await options.beforeSeed?.(first.page)
  await session.close(first.app)
  fixture.app = null
  const seeded = seedRelayEraProfile(
    session.userDataDir,
    host.input,
    {
      repoPath: options.repoPath ?? host.remoteRepoPath,
      folderPath: options.folderPath ?? host.remoteFolderPath
    },
    options.seed
  )
  const { app, page } = await session.launch()
  fixture.app = app
  await options.onLaunch?.(page, seeded)
  await waitForSessionReady(page)
  await convertAndRetain(page, session.userDataDir, seeded)
  const environmentId = await managedEnvironmentId(page, seeded.targetId)
  return { app, page, seeded, environmentId }
}

/** Like `launchConvertedProfile`, and leaves the managed repository active. */
export async function launchManagedWorkspace(
  fixture: ManagedHostFixture,
  options: ManagedProfileOptions = {}
): Promise<ManagedWorkspace> {
  const workspace = await launchConvertedProfile(fixture, options)
  await activateManagedWorkspace(
    workspace.page,
    workspace.seeded.worktreeId,
    workspace.environmentId
  )
  return workspace
}

/** Quits the live launch and relaunches the same profile, waiting for startup to settle. */
export async function relaunchManagedApp(
  fixture: ManagedHostFixture,
  onLaunch?: (page: Page) => void | Promise<void>
): Promise<Page> {
  if (!fixture.app) {
    throw new Error('No live launch to close')
  }
  await fixture.session.close(fixture.app)
  fixture.app = null
  const { app, page } = await fixture.session.launch()
  fixture.app = app
  await onLaunch?.(page)
  await waitForSessionReady(page)
  await waitForStartupWorktreeRefresh(page)
  return page
}

export async function managedEnvironmentId(page: Page, targetId: string): Promise<string> {
  const environment = (await page.evaluate(() => window.api.runtimeEnvironments.list())).find(
    (entry) => entry.orcadDeployment?.sshTargetId === targetId
  )
  if (!environment) {
    throw new Error(`No managed server registered for ${targetId}`)
  }
  return environment.id
}

export async function activateManagedWorkspace(
  page: Page,
  worktreeId: string,
  environmentId: string
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, hostId }) => {
      const state = window.__store!.getState()
      state.setActiveView('terminal')
      state.setActiveWorktree(worktreeId, hostId)
    },
    { worktreeId, hostId: toRuntimeExecutionHostId(environmentId) }
  )
  await dismissTransientAnnouncement(page)
}

export function terminalTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

/** Opens a terminal the way the tab bar's + does and waits for its pane to mount. */
export async function openTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const before = new Set(await terminalTabIds(page, worktreeId))
  await page.evaluate(async (worktreeId) => {
    const state = window.__store!.getState()
    const groupId = state.activeGroupIdByWorktree[worktreeId]
    if (!groupId) {
      throw new Error(`No active tab group for ${worktreeId}`)
    }
    await state.openNewTerminalTabInActiveWorkspace(groupId)
  }, worktreeId)
  let created: string | undefined
  await expect
    .poll(
      async () => {
        created = (await terminalTabIds(page, worktreeId)).find((id) => !before.has(id))
        return created ?? null
      },
      { timeout: 60_000, message: 'the new terminal tab never appeared' }
    )
    .not.toBeNull()
  await waitForPane(page, created!)
  // Keys typed before the shell's first prompt can be lost, as they would be for a user too.
  await expect
    .poll(() => readPairedPaneContent(page, created!), {
      timeout: 60_000,
      message: `the shell in ${created} never printed a prompt`
    })
    .toMatch(/[#$] /)
  return created!
}

export async function waitForPane(page: Page, tabId: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, tabId), {
      timeout: 60_000,
      message: `pane for ${tabId} did not mount`
    })
    .toBe(true)
}

export function selectTerminalTab(page: Page, tabId: string): Promise<void> {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    state.setActiveTab(id)
    state.setActiveTabType('terminal', state.activeWorktreeId)
  }, tabId)
}

/** Types `command` into the tab's pane and presses Enter, as a user at the keyboard would. */
export async function typeInTerminal(page: Page, tabId: string, command: string): Promise<void> {
  await selectTerminalTab(page, tabId)
  await waitForPane(page, tabId)
  await focusActiveTerminalInput(page)
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
}

export async function expectPaneText(
  page: Page,
  tabId: string,
  text: string,
  timeout = 60_000
): Promise<void> {
  await expect
    .poll(() => readPairedPaneContent(page, tabId), {
      timeout,
      message: `pane ${tabId} never showed ${text}`
    })
    .toContain(text)
}

/** Echoes a unique marker and waits for the output; returns the marker. */
export async function echoMarker(
  page: Page,
  tabId: string,
  prefix: string,
  timeout = 60_000
): Promise<string> {
  const marker = `${prefix}_${Date.now()}`
  // Quoted apart so the typed command line itself can never satisfy the check.
  await typeInTerminal(page, tabId, `echo ${prefix}''_${marker.slice(prefix.length + 1)}`)
  await expectPaneText(page, tabId, marker, timeout)
  return marker
}

/** Proves the shell reads input again: retypes a fresh marker until one is echoed back. */
export async function expectTerminalAnswers(
  page: Page,
  tabId: string,
  timeout = 120_000
): Promise<void> {
  await expect(async () => {
    await echoMarker(page, tabId, 'ANSWER', 10_000)
  }).toPass({ timeout })
}
