import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createRestartSession } from './helpers/orca-restart'

/**
 * Journey 12, live half: two REAL Orca processes at DIFFERENT versions talking
 * over the real desktop-pairing transport. The in-process wire suite under
 * `tests/e2e/cross-version-wire/` pairs two builds inside one Node process; this
 * spec pairs two builds as two operating-system processes.
 *
 * `ORCA_J12_OLD_APP_ROOT` must point at a second, fully built checkout of an
 * older release. The spec refuses to run rather than silently degrading into a
 * same-version pairing, which would look green and prove nothing.
 */
const oldAppRoot = process.env.ORCA_J12_OLD_APP_ROOT?.trim()

test.skip(!oldAppRoot, 'Set ORCA_J12_OLD_APP_ROOT to a built older-release checkout')

test.describe.configure({ mode: 'serial' })

type PaneCoordinates = {
  worktreeId: string
  tabId: string
  leafId: string
  paneKey: string
}

/** Handle plus the identity of the process actually behind it. */
type PaneShellIdentity = {
  handle: string
  ptyId: string | null
  /** `$$` reported by the shell itself through the production terminal path. */
  shellPid: string
  /**
   * Kernel start time of that pid. Journey 1 established that ids alone prove
   * nothing: a replacement shell can reuse a pane id, a leaf id and even a pid.
   */
  shellStartTime: string
}

async function readClientVersion(client: PairedElectronClient): Promise<string> {
  return client.app.evaluate(({ app }) => app.getVersion())
}

async function callHub(
  client: PairedElectronClient,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return client.page.evaluate(
    ({ environmentId, method, params }) =>
      window.api.runtimeEnvironments.call({ selector: environmentId, method, params }),
    { environmentId: client.environmentId, method, params }
  ) as Promise<Record<string, unknown>>
}

async function readPaneCoordinates(client: PairedElectronClient): Promise<PaneCoordinates> {
  const coordinates = await client.page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId ?? null
    const tabs = worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []) : []
    const tabId = state?.activeTabId ?? tabs[0]?.id ?? null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const leafId = pane?.leafId ?? null
    return { worktreeId, tabId, leafId }
  })
  if (!coordinates.worktreeId || !coordinates.tabId || !coordinates.leafId) {
    // Known gap: the restart fixture launches a HUB with no workspace, so the
    // paired client has nothing to mirror. The nested-runtime specs get theirs
    // from the docker SSH repo; this spec still needs that seeding step.
    throw new Error(`Paired client has no resolvable pane: ${JSON.stringify(coordinates)}`)
  }
  return {
    worktreeId: coordinates.worktreeId,
    tabId: coordinates.tabId,
    leafId: coordinates.leafId,
    paneKey: `${coordinates.tabId}:${coordinates.leafId}`
  }
}

/**
 * Ask the shell itself who it is, through `terminal.send` / `terminal.read` —
 * the same runtime methods the product uses. A pid alone can be recycled, so the
 * probe also reports the kernel's start time for that pid.
 */
async function readPaneShellIdentity(
  client: PairedElectronClient,
  pane: PaneCoordinates,
  marker: string
): Promise<PaneShellIdentity> {
  const resolved = (await callHub(client, 'terminal.resolvePane', {
    paneKey: pane.paneKey,
    worktreeId: pane.worktreeId
  })) as { ok?: boolean; result?: { terminal?: { handle?: string; ptyId?: string | null } } }
  const terminal = resolved.result?.terminal
  if (!terminal?.handle) {
    throw new Error(`HUB did not resolve pane ${pane.paneKey}: ${JSON.stringify(resolved)}`)
  }
  const send = await callHub(client, 'terminal.send', {
    terminal: terminal.handle,
    text: `printf '${marker}%s %s\\n' "$$" "$(ps -o lstart= -p $$ | tr -s ' ' '_')"\n`,
    client: { id: 'j12-live-skew', type: 'desktop' }
  })
  if (send.ok !== true) {
    throw new Error(`terminal.send failed: ${JSON.stringify(send)}`)
  }
  let captured: { pid: string; startTime: string } | null = null
  await expect
    .poll(
      async () => {
        const read = (await callHub(client, 'terminal.read', {
          terminal: terminal.handle,
          lines: 400
        })) as { result?: { read?: { content?: string } } }
        const content = read.result?.read?.content ?? ''
        const match = [...content.matchAll(new RegExp(`${marker}(\\d+) (\\S+)`, 'g'))].at(-1)
        if (!match) {
          return false
        }
        captured = { pid: match[1], startTime: match[2] }
        return true
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  if (!captured) {
    throw new Error(`Shell never reported its identity for marker ${marker}`)
  }
  return {
    handle: terminal.handle,
    ptyId: terminal.ptyId ?? null,
    shellPid: captured.pid,
    shellStartTime: captured.startTime
  }
}

test('an older paired client keeps its HUB shell across a HUB restart', async ({
  orcaAppExtraEnv: _orcaAppExtraEnv
}, testInfo) => {
  test.setTimeout(600_000)
  const hub = createRestartSession(testInfo)
  let client: PairedElectronClient | null = null
  let hubLaunch: Awaited<ReturnType<typeof hub.launch>> | null = null
  try {
    hubLaunch = await hub.launch()
    await hubLaunch.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
    const hubVersion = await hubLaunch.app.evaluate(({ app }) => app.getVersion())
    const offer = await createRuntimeDesktopPairingOffer(hubLaunch.page)
    client = await launchPairedElectronClient(offer, testInfo, 'J12 old paired client', oldAppRoot)
    const clientVersion = await readClientVersion(client)

    // Vacuity guard: a same-version pairing would pass every assertion below
    // while proving nothing about skew.
    expect(
      clientVersion,
      `Paired client at ${oldAppRoot} reports the same version as the HUB (${hubVersion}); ` +
        'this run would not exercise any version skew.'
    ).not.toBe(hubVersion)

    console.log(`[j12-live] HUB=${hubVersion} pairedClient=${clientVersion}`)
    console.log(
      `[j12-live] hub worktrees=${JSON.stringify(
        await hubLaunch.page.evaluate(() =>
          Object.values(window.__store?.getState().worktreesByRepo ?? {})
            .flat()
            .map((worktree) => worktree.id)
        )
      )}`
    )

    const pane = await readPaneCoordinates(client)
    const before = await readPaneShellIdentity(client, pane, `J12_BEFORE_${Date.now()}_`)
    const preRestartEnvironmentId = client.environmentId

    await hub.close(hubLaunch.app)
    hubLaunch = await hub.launch()
    await hubLaunch.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
    const recovered = await client.page.evaluate(async (environmentId) => {
      const store = window.__store
      if (!store) {
        return false
      }
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(environmentId))) {
        return false
      }
      return store.getState().switchRuntimeEnvironment(environmentId)
    }, preRestartEnvironmentId)
    expect(recovered).toBe(true)

    const after = await readPaneShellIdentity(client, pane, `J12_AFTER_${Date.now()}_`)

    // A `terminal.recoverPane` would mint a new handle and a new shell. Ids
    // matching is not enough: the start time proves it is the same process.
    expect(after.handle).toBe(before.handle)
    expect(after.shellPid).toBe(before.shellPid)
    expect(after.shellStartTime).toBe(before.shellStartTime)
  } finally {
    await client?.dispose()
    if (hubLaunch) {
      await hub.close(hubLaunch.app)
    }
    await hub.dispose()
  }
})
