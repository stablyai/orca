import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { assertInteractiveTerminal } from './helpers/nested-runtime-ssh-client-route'
import { readOwnedPageUrls } from './helpers/client-hosted-browser-observer'
import {
  killSshRelayTargetTransport,
  readSshRemoteOnlyRequests,
  startSshRemoteOnlyBrowserFixture,
  SSH_REMOTE_ONLY_COOKIE_NAME,
  SSH_REMOTE_ONLY_COOKIE_VALUE,
  SSH_REMOTE_ONLY_ORIGIN
} from './helpers/ssh-remote-only-browser-fixture'

/**
 * A client-hosted browser page whose egress runs through a nested SSH execution host, across a
 * real SSH transport kill.
 *
 * Topology: HUB desktop (runtime, owns the SSH target) <- paired desktop (hosts the page). The
 * page's origin only exists inside the SSH container, so rendering it at all proves the egress
 * path; the SSH drop is a real `kill -9` of the container's sshd sessions, never a stubbed state.
 *
 * The reconnect mints a new `connectionGeneration`, so the next `createPage` carries a new route
 * key while the storage identity (`['ssh', targetId]`) stays put. That asymmetry is the whole
 * mechanism under test: the new route can only bind the partition once the superseded pages are
 * retired, and the cookie jar has to survive because the partition name never changed.
 */
const COOKIE_PAIR = `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
const LOGIN_URL = `${SSH_REMOTE_ONLY_ORIGIN}/login`
const ECHO_BEFORE_URL = `${SSH_REMOTE_ONLY_ORIGIN}/echo/before`
const ECHO_AFTER_URL = `${SSH_REMOTE_ONLY_ORIGIN}/echo/after`
const ROUTE_PARTITION_RE = /^persist:orca-browser-v1-[a-f0-9]{64}$/

type HubSshState = {
  status: string | null
  connectionGeneration: number | null
  providerEpoch: string | null
}

type RenderedClientPage = { marker: string; partition: string }

test.skip(
  process.env.ORCA_E2E_SSH_CLIENT_HOSTED_BROWSER !== '1',
  'Run with ORCA_E2E_SSH_CLIENT_HOSTED_BROWSER=1 (requires Docker)'
)

async function readHubSshState(page: Page, targetId: string): Promise<HubSshState> {
  return page.evaluate(async (targetId) => {
    const state = await window.api.ssh.getState({ targetId })
    return {
      status: state?.status ?? null,
      connectionGeneration: state?.connectionGeneration ?? null,
      providerEpoch: state?.providerEpoch ?? null
    }
  }, targetId)
}

/**
 * Drives the HUB back to a connected SSH target after the transport was killed.
 *
 * `ssh:connect` short-circuits for a still-live session, so a generation that advances here is
 * proof the kill actually landed rather than an artifact of asking for a reconnect.
 */
async function reconnectHubSshTarget(page: Page, targetId: string): Promise<HubSshState> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (targetId) => {
          try {
            const state = await window.api.ssh.connect({ targetId })
            if (state) {
              window.__store?.getState().setSshConnectionState(targetId, state)
            }
            return state?.status ?? null
          } catch {
            return null
          }
        }, targetId),
      {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
        message: 'HUB never reconnected the SSH target after the transport kill'
      }
    )
    .toBe('connected')
  return readHubSshState(page, targetId)
}

async function waitForPairedGroupId(page: Page, worktreeId: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate((worktreeId) => {
          const state = window.__store?.getState()
          if (!state) {
            return null
          }
          if (state.activeWorktreeId !== worktreeId) {
            state.setActiveWorktree(worktreeId)
          }
          return state.activeGroupIdByWorktree[worktreeId] ?? null
        }, worktreeId),
      {
        timeout: 120_000,
        message: 'paired client never activated a tab group for the SSH worktree'
      }
    )
    .not.toBeNull()
  const groupId = await page.evaluate(
    (worktreeId) => window.__store?.getState().activeGroupIdByWorktree[worktreeId] ?? null,
    worktreeId
  )
  if (!groupId) {
    throw new Error('Paired client lost the SSH worktree tab group')
  }
  return groupId
}

async function findMirroredBrowserPage(
  page: Page,
  worktreeId: string,
  url: string
): Promise<{ localPageId: string; placementKind: 'client' | 'server' | null } | null> {
  return page.evaluate(
    ({ url, worktreeId }) => {
      const state = window.__store?.getState()
      for (const workspace of state?.browserTabsByWorktree[worktreeId] ?? []) {
        for (const browserPage of state?.browserPagesByWorkspace[workspace.id] ?? []) {
          if (!browserPage.url.startsWith(url)) {
            continue
          }
          const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
          return {
            localPageId: browserPage.id,
            placementKind: handle?.placement?.kind ?? null
          }
        }
      }
      return null
    },
    { url, worktreeId }
  )
}

async function readClientWebview(
  page: Page,
  url: string
): Promise<{ marker: string | null; partition: string | null } | null> {
  return page.evaluate(async (prefix) => {
    for (const candidate of document.querySelectorAll('webview')) {
      const webview = candidate as Electron.WebviewTag
      try {
        if (!webview.getURL().startsWith(prefix)) {
          continue
        }
        return {
          marker: (await webview.executeJavaScript(
            'document.querySelector("#marker")?.textContent ?? null'
          )) as string | null,
          partition: webview.getAttribute('partition')
        }
      } catch {
        // The guest may still be attaching.
      }
    }
    return null
  }, url)
}

async function countClientWebviews(page: Page, prefixes: readonly string[]): Promise<number> {
  return page.evaluate(
    (prefixes) =>
      [...document.querySelectorAll('webview')].filter((candidate) => {
        try {
          const url = (candidate as Electron.WebviewTag).getURL()
          return prefixes.some((prefix) => url.startsWith(prefix))
        } catch {
          return false
        }
      }).length,
    [...prefixes]
  )
}

/**
 * Opens one client-hosted page on the SSH-routed worktree and waits for its guest to paint.
 *
 * The rendered `#marker` is the SSH-egress oracle: `remote-only.internal` resolves nowhere on the
 * viewing desktop, so a marker can only have come back through the tunnel.
 */
async function openClientHostedSshPage(
  client: PairedElectronClient,
  worktreeId: string,
  groupId: string,
  url: string
): Promise<RenderedClientPage> {
  await client.page.evaluate(
    async ({ groupId, url }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Paired client store is unavailable')
      }
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(groupId)
    },
    { groupId, url }
  )
  await expect
    .poll(() => findMirroredBrowserPage(client.page, worktreeId, url), {
      timeout: 120_000,
      message: `paired client never materialized ${url}`
    })
    .not.toBeNull()
  const mirrored = await findMirroredBrowserPage(client.page, worktreeId, url)
  if (!mirrored) {
    throw new Error(`Mirrored browser page disappeared for ${url}`)
  }
  expect(mirrored.placementKind, `${url} must be hosted on the viewing desktop`).toBe('client')
  await client.page.evaluate(
    ({ browserPageId, worktreeId }) => {
      window.__store
        ?.getState()
        .focusBrowserTabInWorktree(worktreeId, browserPageId, { surfacePane: true })
    },
    { browserPageId: mirrored.localPageId, worktreeId }
  )
  await expect
    .poll(async () => (await readClientWebview(client.page, url))?.marker ?? null, {
      timeout: 120_000,
      message: `client-hosted guest never rendered ${url} through the SSH execution host`
    })
    .not.toBeNull()
  const rendered = await readClientWebview(client.page, url)
  if (!rendered?.marker || !rendered.partition) {
    throw new Error(`Client-hosted guest for ${url} lost its marker or partition`)
  }
  return { marker: rendered.marker, partition: rendered.partition }
}

test('recovers client-hosted SSH-routed browser pages across a real SSH drop', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(900_000)
  let target: DockerSshRelayTarget | null = null
  let client: PairedElectronClient | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    startSshRemoteOnlyBrowserFixture(target)
    const remote = await connectDockerSshRelayTarget(orcaPage, target)

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    client = await launchPairedElectronClient(
      offer,
      testInfo,
      'STA-4150 SSH client-hosted browser drop'
    )
    const sshRoute = await assertInteractiveTerminal(
      client,
      remote.repoId,
      `SSH_CLIENT_HOSTED_BROWSER_${Date.now()}`
    )
    expect(sshRoute.worktreeHostId, 'the workspace must live on the HUB-owned SSH host').toBe(
      `ssh:${remote.targetId}`
    )
    expect(
      sshRoute.localSshTargetIds,
      'the viewing desktop must never own the SSH target itself'
    ).not.toContain(remote.targetId)
    const worktreeId = sshRoute.worktreeId
    const groupId = await waitForPairedGroupId(client.page, worktreeId)

    // (1) A client-hosted page whose egress runs through the SSH execution host.
    const login = await openClientHostedSshPage(client, worktreeId, groupId, LOGIN_URL)
    expect(login.marker).toBe('login-marker')
    expect(login.partition, 'client-hosted pages must use a derived route partition').toMatch(
      ROUTE_PARTITION_RE
    )
    const echoBefore = await openClientHostedSshPage(client, worktreeId, groupId, ECHO_BEFORE_URL)
    expect(echoBefore.marker, 'the pre-drop request must carry the planted cookie').toContain(
      COOKIE_PAIR
    )
    expect(echoBefore.partition).toBe(login.partition)

    // Positive control for the zombie check below: both guests are live right now, so a later
    // empty census is retirement rather than a census that never sees anything.
    await expect
      .poll(() => readOwnedPageUrls(client!.app, SSH_REMOTE_ONLY_ORIGIN), {
        timeout: 30_000,
        message: 'the viewing desktop never owned both pre-drop SSH-routed guests at once'
      })
      .toEqual(expect.arrayContaining([LOGIN_URL, ECHO_BEFORE_URL]))

    const beforeDrop = await readHubSshState(orcaPage, remote.targetId)
    expect(beforeDrop.status).toBe('connected')
    expect(beforeDrop.connectionGeneration).not.toBeNull()

    // (2) Kill the real SSH transport, then reconnect onto a new generation.
    expect(
      killSshRelayTargetTransport(target),
      'the container had no established SSH session to kill'
    ).toBeGreaterThan(0)
    const afterDrop = await reconnectHubSshTarget(orcaPage, remote.targetId)
    expect(
      afterDrop.connectionGeneration,
      'a reconnect must mint a new SSH connection generation'
    ).toBeGreaterThan(beforeDrop.connectionGeneration!)

    // Nothing proactively retires a superseded page, so the fenced guests are still mounted here.
    // Pinning that keeps the check below honest: the emptied census afterwards is the supersession
    // path doing the work, not a host that had already collapsed and taken its pages with it.
    const ownedBeforeSupersession = await readOwnedPageUrls(client.app, SSH_REMOTE_ONLY_ORIGIN)
    await testInfo.attach('owned-pages-before-supersession', {
      body: JSON.stringify(ownedBeforeSupersession),
      contentType: 'application/json'
    })
    expect(
      [...ownedBeforeSupersession].sort(),
      'the superseded guests must survive the drop so the next create is what retires them'
    ).toEqual([ECHO_BEFORE_URL, LOGIN_URL])

    // (3)+(4) The next create binds the same partition on the new generation. It can only
    // succeed once the superseded pages release that partition, because the new route carries a
    // different local proxy endpoint for the same partition name.
    const echoAfter = await openClientHostedSshPage(client, worktreeId, groupId, ECHO_AFTER_URL)
    expect(
      echoAfter.partition,
      'an SSH reconnect must not mint a fresh client-hosted partition'
    ).toBe(login.partition)
    expect(
      echoAfter.marker,
      'the post-reconnect request must still carry the cookie planted before the drop'
    ).toContain(COOKIE_PAIR)

    await expect
      .poll(() => countClientWebviews(client!.page, [LOGIN_URL, ECHO_BEFORE_URL]), {
        timeout: 120_000,
        message: 'superseded client-hosted guests stayed mounted after the new generation started'
      })
      .toBe(0)
    await expect
      .poll(() => readOwnedPageUrls(client!.app, SSH_REMOTE_ONLY_ORIGIN), {
        timeout: 120_000,
        message: 'the viewing desktop still owned a superseded SSH-routed guest'
      })
      .toEqual([ECHO_AFTER_URL])

    const requests = readSshRemoteOnlyRequests(target)
    expect(
      requests.find((entry) => entry.path === '/login')?.cookie ?? null,
      'the first request must arrive without the cookie'
    ).toBeNull()
    expect(
      requests.findLast((entry) => entry.path === '/echo/after')?.cookie,
      'the remote-only origin must have seen the surviving cookie after the reconnect'
    ).toContain(COOKIE_PAIR)
  } finally {
    await client?.dispose()
    cleanupDockerSshRelayTarget(target)
  }
})
