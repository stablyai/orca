import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import {
  blockDockerSshRelayTargetTcpForwarding,
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  killSshRelayTargetTransport,
  readSshRemoteOnlyRequests,
  startSshRemoteOnlyBrowserFixture,
  SSH_REMOTE_ONLY_COOKIE_NAME,
  SSH_REMOTE_ONLY_COOKIE_VALUE,
  SSH_REMOTE_ONLY_ORIGIN
} from './helpers/ssh-remote-only-browser-fixture'
import {
  installBrowserPaneMountCensus,
  readBrowserPaneMountCensus,
  type BrowserPaneMountCensusEntry
} from './helpers/browser-pane-mount-census'

/**
 * Browser pages in a workspace whose execution host is the app's OWN directly-connected SSH
 * target — no paired runtime anywhere — must egress through that SSH connection.
 *
 * The oracle is causal, not bookkeeping: the origin lives on `remote-only.internal:18080` inside
 * the container, bound to the container's loopback and absent from the desktop's resolver. A
 * rendered marker is therefore only reachable if the TCP connection was opened inside the
 * container by the app's own ssh2 `forwardOut`. The opt-out case at the end is the negative
 * control for exactly that claim: same URL, routing off, and the origin never sees a request.
 *
 * The mount census is the fail-closed half. Reading the partition after the fact cannot see a
 * webview that existed for one frame on the wrong session, so a MutationObserver installed before
 * the first tab records every `<webview>` the pane ever attached along with the partition it was
 * born with — Electron partitions are immutable after creation, so the birth attribute is the
 * whole story.
 */
const COOKIE_PAIR = `${SSH_REMOTE_ONLY_COOKIE_NAME}=${SSH_REMOTE_ONLY_COOKIE_VALUE}`
const LOGIN_URL = `${SSH_REMOTE_ONLY_ORIGIN}/login`
const ECHO_URL = `${SSH_REMOTE_ONLY_ORIGIN}/echo/session`
const OPT_OUT_URL = `${SSH_REMOTE_ONLY_ORIGIN}/echo/opt-out`
const ROUTE_PARTITION_RE = /^persist:orca-browser-v1-[a-f0-9]{64}$/

const FORWARDING_BLOCKED_TITLE = 'The SSH server blocks browser traffic'
const SSH_UNAVAILABLE_TITLE = 'SSH connection unavailable'
const BROWSE_LOCALLY_LABEL = 'Browse from this device instead'
const LOCAL_DEVICE_MARKER = 'local-device-marker'

type SshState = {
  status: string | null
  connectionGeneration: number | null
  providerEpoch: string | null
}

type CreatedBrowserTab = { id: string; pageId: string | null }

type WebviewProbe = { partition: string | null; url: string | null; marker: string | null }

type ReloadOutcome = {
  outcome: 'loaded' | 'failed' | 'timeout' | 'no-webview' | 'threw' | 'unattempted'
  errorCode?: number
  errorDescription?: string
}

test.skip(
  process.env.ORCA_E2E_LOCAL_SSH_BROWSER !== '1',
  'Run with ORCA_E2E_LOCAL_SSH_BROWSER=1 (requires Docker)'
)

// Why: every workspace here is created on the SSH target, so the seeded local repo is dead weight
// — and its readiness gate polls real git worktrees, which was observed timing out on a third
// consecutive app launch. Opting out removes a failure mode these specs cannot otherwise dodge.
test.use({ seedTestRepo: false })

async function readSshState(page: Page, targetId: string): Promise<SshState> {
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
 * `ssh:connect` short-circuits for a still-live session, so an advancing generation here is proof
 * the `kill -9` actually landed rather than an artifact of asking for a reconnect.
 */
async function reconnectSshTarget(page: Page, targetId: string): Promise<SshState> {
  await expect
    .poll(
      () =>
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
        message: 'the SSH target never reconnected after the transport kill'
      }
    )
    .toBe('connected')
  return readSshState(page, targetId)
}

async function createBrowserTab(
  page: Page,
  worktreeId: string,
  url: string,
  title: string
): Promise<CreatedBrowserTab> {
  const created = await page.evaluate(
    ({ worktreeId, url, title }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      const tab = state.createBrowserTab(worktreeId, url, { title, activate: true })
      return { id: tab.id, pageId: tab.activePageId ?? null }
    },
    { worktreeId, url, title }
  )
  await expect
    .poll(
      () =>
        page.evaluate(
          (tabId) =>
            (
              window.__store?.getState().browserTabsByWorktree[
                window.__store.getState().activeWorktreeId ?? ''
              ] ?? []
            ).some((tab) => tab.id === tabId),
          created.id
        ),
      { timeout: 30_000, message: `browser tab ${title} never landed in the store` }
    )
    .toBe(true)
  return created
}

async function probeTabWebview(page: Page, tabId: string): Promise<WebviewProbe | null> {
  return page.evaluate(async (tabId) => {
    const slot = document.querySelector(`[data-browser-overlay-tab-id="${tabId}"]`)
    const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return null
    }
    let url: string | null = null
    try {
      url = webview.getURL()
    } catch {
      url = null
    }
    let marker: string | null = null
    try {
      marker = (await webview.executeJavaScript(
        'document.querySelector("#marker")?.textContent ?? null'
      )) as string | null
    } catch {
      marker = null
    }
    return { partition: webview.getAttribute('partition'), url, marker }
  }, tabId)
}

/** Reloads one tab's guest and reports the main-frame outcome the guest itself emitted. */
async function reloadTab(page: Page, tabId: string, timeoutMs: number): Promise<ReloadOutcome> {
  return page.evaluate(
    ({ tabId, timeoutMs }) => {
      const slot = document.querySelector(`[data-browser-overlay-tab-id="${tabId}"]`)
      const webview = slot?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        return Promise.resolve({ outcome: 'no-webview' as const })
      }
      return new Promise<ReloadOutcome>((resolve) => {
        let settled = false
        const cleanup = (): void => {
          window.clearTimeout(timer)
          webview.removeEventListener('did-fail-load', onFail)
          webview.removeEventListener('did-finish-load', onFinish)
        }
        const finish = (value: ReloadOutcome): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          resolve(value)
        }
        const onFail = (event: Event): void => {
          const failure = event as Event & {
            errorCode: number
            errorDescription: string
            isMainFrame?: boolean
          }
          // ERR_ABORTED is what a superseded navigation reports; it is not a load failure.
          if (failure.isMainFrame === false || failure.errorCode === -3) {
            return
          }
          finish({
            outcome: 'failed',
            errorCode: failure.errorCode,
            errorDescription: failure.errorDescription
          })
        }
        const onFinish = (): void => finish({ outcome: 'loaded' })
        const timer = window.setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs)
        webview.addEventListener('did-fail-load', onFail)
        webview.addEventListener('did-finish-load', onFinish)
        try {
          webview.reload()
        } catch (error) {
          finish({ outcome: 'threw', errorDescription: String(error) })
        }
      })
    },
    { tabId, timeoutMs }
  ) as Promise<ReloadOutcome>
}

async function readPageLoadError(
  page: Page,
  tabId: string
): Promise<{ code: string | number | null; description: string | null } | null> {
  return page.evaluate((tabId) => {
    const pages = window.__store?.getState().browserPagesByWorkspace[tabId] ?? []
    const failure = pages.find((candidate) => candidate.loadError)?.loadError
    if (!failure) {
      return null
    }
    return { code: failure.code ?? null, description: failure.description ?? null }
  }, tabId)
}

/** Waits until the guest for one tab has painted the fixture's marker element. */
async function waitForTabMarker(page: Page, tabId: string, message: string): Promise<string> {
  await expect
    .poll(async () => (await probeTabWebview(page, tabId))?.marker ?? null, {
      timeout: 120_000,
      intervals: [250, 500, 1_000],
      message
    })
    .not.toBeNull()
  const marker = (await probeTabWebview(page, tabId))?.marker
  if (!marker) {
    throw new Error(`Guest for ${tabId} lost its marker`)
  }
  return marker
}

function censusFor(
  census: readonly BrowserPaneMountCensusEntry[],
  tabId: string
): BrowserPaneMountCensusEntry[] {
  return census.filter((entry) => entry.overlayTabId === tabId)
}

test('routes SSH-workspace browsing through the SSH host, fail-closed across a real drop', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(900_000)
  let target: DockerSshRelayTarget | null = null
  try {
    await waitForSessionReady(orcaPage)

    target = startDockerSshRelayTarget(testInfo)
    startSshRemoteOnlyBrowserFixture(target)
    const remote = await connectDockerSshRelayTarget(orcaPage, target)
    const worktreeId = remote.worktreeId

    expect(
      await orcaPage.evaluate(
        ({ repoId, worktreeId }) =>
          (window.__store?.getState().worktreesByRepo[repoId] ?? []).find(
            (worktree) => worktree.id === worktreeId
          )?.hostId ?? null,
        { repoId: remote.repoId, worktreeId }
      ),
      'the workspace must execute on the directly-connected SSH target'
    ).toBe(`ssh:${remote.targetId}`)
    expect(
      await orcaPage.evaluate(
        (repoId) =>
          window.__store?.getState().repos.find((repo) => repo.id === repoId)?.connectionId ?? null,
        remote.repoId
      ),
      'no paired runtime may be involved: the repo is owned by the SSH connection itself'
    ).toBe(remote.targetId)

    // Installed before the first tab: a webview that mounts on the wrong session and is replaced
    // milliseconds later is invisible to any after-the-fact DOM read.
    await installBrowserPaneMountCensus(orcaPage)

    // (1) Remote-only origin renders -- the causal egress oracle.
    const loginTab = await createBrowserTab(orcaPage, worktreeId, LOGIN_URL, 'SSH login')
    const loginMarker = await waitForTabMarker(
      orcaPage,
      loginTab.id,
      'the SSH-routed guest never rendered the container-only origin'
    )
    expect(loginMarker, 'the remote-only origin must have served the page itself').toBe(
      'login-marker'
    )

    // (2) Partition shape + the gate's fail-closed mount order.
    const loginProbe = await probeTabWebview(orcaPage, loginTab.id)
    expect(
      loginProbe?.partition,
      'SSH-workspace pages must mount on a derived route partition'
    ).toMatch(ROUTE_PARTITION_RE)

    const routedCensus = await readBrowserPaneMountCensus(orcaPage)
    await testInfo.attach('mount-census-routed', {
      body: JSON.stringify(routedCensus, null, 2),
      contentType: 'application/json'
    })
    const loginCensus = censusFor(routedCensus, loginTab.id)
    expect(
      loginCensus[0]?.kind,
      'the pane must show the SSH-routing gate before anything mounts'
    ).toBe('gate-preparing')
    expect(
      loginCensus.filter((entry) => entry.kind === 'webview').length,
      'the SSH-routed pane never attached a guest at all'
    ).toBeGreaterThan(0)
    for (const entry of loginCensus) {
      if (entry.kind === 'webview') {
        expect(
          entry.partition,
          'the pane must never attach an unrouted guest, not even transiently'
        ).toMatch(ROUTE_PARTITION_RE)
      }
    }

    // (3) Container-side confirmation: the origin logged the request the desktop could not make.
    const loginRequests = readSshRemoteOnlyRequests(target)
    expect(
      loginRequests.map((entry) => entry.path),
      'the container-side origin never recorded the routed request'
    ).toContain('/login')
    expect(
      loginRequests.find((entry) => entry.path === '/login')?.cookie ?? null,
      'the first request must arrive without the planted cookie'
    ).toBeNull()

    // A second tab on the same partition proves the cookie jar is shared before the drop.
    const echoTab = await createBrowserTab(orcaPage, worktreeId, ECHO_URL, 'SSH echo')
    const echoMarker = await waitForTabMarker(
      orcaPage,
      echoTab.id,
      'the second SSH-routed guest never rendered the container-only origin'
    )
    expect(echoMarker, 'the pre-drop request must carry the planted cookie').toContain(COOKIE_PAIR)
    expect(
      (await probeTabWebview(orcaPage, echoTab.id))?.partition,
      'both SSH-workspace tabs must share one route partition'
    ).toBe(loginProbe?.partition)

    const beforeDrop = await readSshState(orcaPage, remote.targetId)
    expect(beforeDrop.status).toBe('connected')
    expect(beforeDrop.connectionGeneration).not.toBeNull()
    const requestsBeforeDrop = readSshRemoteOnlyRequests(target).length

    // (4) Drop the real transport. A reload must FAIL rather than silently succeed locally.
    expect(
      killSshRelayTargetTransport(target),
      'the container had no established SSH session to kill'
    ).toBeGreaterThan(0)

    let dropOutcome: ReloadOutcome = { outcome: 'unattempted' }
    await expect
      .poll(
        async () => {
          dropOutcome = await reloadTab(orcaPage, echoTab.id, 30_000)
          return dropOutcome.outcome
        },
        {
          timeout: 180_000,
          intervals: [1_000, 2_000],
          message: 'a reload survived the SSH drop, so the page was not egressing through SSH'
        }
      )
      .toBe('failed')
    await testInfo.attach('reload-outcome-after-drop', {
      body: JSON.stringify(dropOutcome),
      contentType: 'application/json'
    })
    expect(
      await readPageLoadError(orcaPage, echoTab.id),
      'the fenced page must surface a load failure in the product state'
    ).not.toBeNull()
    expect(
      (await probeTabWebview(orcaPage, echoTab.id))?.marker ?? null,
      'the fenced page must not still be showing remote content'
    ).toBeNull()
    expect(
      readSshRemoteOnlyRequests(target).length,
      'nothing reached the container-only origin while the SSH transport was dead'
    ).toBe(requestsBeforeDrop)

    // Reconnect: same SOCKS port, new SSH generation, same tab.
    const afterDrop = await reconnectSshTarget(orcaPage, remote.targetId)
    expect(
      afterDrop.connectionGeneration,
      'a reconnect must mint a new SSH connection generation'
    ).toBeGreaterThan(beforeDrop.connectionGeneration!)

    let recoveryOutcome: ReloadOutcome = { outcome: 'unattempted' }
    await expect
      .poll(
        async () => {
          recoveryOutcome = await reloadTab(orcaPage, echoTab.id, 30_000)
          return recoveryOutcome.outcome
        },
        {
          timeout: 180_000,
          intervals: [1_000, 2_000],
          message: 'the same tab never recovered its SSH-routed egress after the reconnect'
        }
      )
      .toBe('loaded')
    const recoveredMarker = await waitForTabMarker(
      orcaPage,
      echoTab.id,
      'the reconnected guest never re-rendered the container-only origin'
    )
    expect(
      recoveredMarker,
      'the post-reconnect request must still carry the cookie planted before the drop'
    ).toContain(COOKIE_PAIR)
    expect(
      (await probeTabWebview(orcaPage, echoTab.id))?.partition,
      'a reconnect must not mint a fresh partition'
    ).toBe(loginProbe?.partition)

    const requestsAfterRecovery = readSshRemoteOnlyRequests(target)
    const postDropRequests = requestsAfterRecovery.slice(requestsBeforeDrop)
    await testInfo.attach('remote-only-requests-after-recovery', {
      body: JSON.stringify(postDropRequests, null, 2),
      contentType: 'application/json'
    })
    expect(
      postDropRequests.map((entry) => entry.path),
      'the container-only origin must have served the reload that followed the reconnect'
    ).toContain('/echo/session')
    expect(
      postDropRequests.findLast((entry) => entry.path === '/echo/session')?.cookie ?? null,
      'the surviving partition must have replayed the pre-drop cookie after the reconnect'
    ).toContain(COOKIE_PAIR)

    // (5) Opt-out: a new tab must mount unrouted -- and then it cannot reach the origin at all,
    // which is the negative control for every rendered marker above.
    const requestsBeforeOptOut = readSshRemoteOnlyRequests(target).length
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ browserSshWorkspaceRoutingEnabled: false })
    })
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () => window.__store?.getState().settings?.browserSshWorkspaceRoutingEnabled ?? null
          ),
        { timeout: 30_000, message: 'the routing opt-out never reached the renderer store' }
      )
      .toBe(false)

    const optOutTab = await createBrowserTab(orcaPage, worktreeId, OPT_OUT_URL, 'SSH opt-out')
    await expect
      .poll(async () => (await probeTabWebview(orcaPage, optOutTab.id))?.partition ?? null, {
        timeout: 60_000,
        message: 'the opt-out tab never attached a guest'
      })
      .not.toBeNull()
    const optOutPartition = (await probeTabWebview(orcaPage, optOutTab.id))?.partition
    expect(
      optOutPartition,
      'with routing disabled a new tab must not mount on a route partition'
    ).not.toMatch(ROUTE_PARTITION_RE)

    const optOutCensus = censusFor(await readBrowserPaneMountCensus(orcaPage), optOutTab.id)
    expect(
      optOutCensus.some((entry) => entry.kind === 'gate-preparing'),
      'the opt-out pane must skip the SSH-routing gate entirely'
    ).toBe(false)
    await expect
      .poll(async () => (await reloadTab(orcaPage, optOutTab.id, 30_000)).outcome, {
        timeout: 120_000,
        intervals: [1_000, 2_000],
        message: 'an unrouted guest reached the container-only origin, so the oracle is not causal'
      })
      .toBe('failed')
    expect(
      readSshRemoteOnlyRequests(target).length,
      'the container-only origin must be unreachable without the SSH route'
    ).toBe(requestsBeforeOptOut)
  } finally {
    cleanupDockerSshRelayTarget(target)
  }
})

/**
 * An origin only the DESKTOP can reach: the mirror image of the container-only fixture.
 *
 * The container has no route to the host's loopback, and the SSH route dials the container's
 * loopback, so this marker rendering proves egress left from this device — which is exactly what
 * the "Browse from this device instead" escape hatch claims to restore.
 */
async function startHostPublishedOrigin(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(
      `<!doctype html><html><head><title>${LOCAL_DEVICE_MARKER}</title></head><body><h1 id="marker">${LOCAL_DEVICE_MARKER}</h1></body></html>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/local`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  }
}

/**
 * The prepare-time probe's fail-closed path, driven end to end against a real sshd.
 *
 * With the SSH host unavailable the probe cannot resolve a route, so `prepare` rejects and the
 * gate must hold the mount rather than fall back to local egress. What makes this worth an e2e is
 * the escape hatch: "Browse from this device instead" is the ONLY sanctioned unrouted path, and
 * proving it works needs an origin that only this device can reach — otherwise "it loaded" says
 * nothing about which machine opened the socket.
 */
test('holds the mount and offers a working local escape hatch when the SSH host is unavailable', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(900_000)
  let target: DockerSshRelayTarget | null = null
  let hostOrigin: { url: string; close: () => Promise<void> } | null = null
  try {
    await waitForSessionReady(orcaPage)
    // Why: the gate's cards are asserted by their user-visible English text.
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })

    hostOrigin = await startHostPublishedOrigin()
    target = startDockerSshRelayTarget(testInfo)
    // The container-only origin stays healthy for the whole test; nothing may ever reach it.
    startSshRemoteOnlyBrowserFixture(target)
    const remote = await connectDockerSshRelayTarget(orcaPage, target)
    const worktreeId = remote.worktreeId

    await installBrowserPaneMountCensus(orcaPage)
    await orcaPage.evaluate(
      async (targetId) => window.api.ssh.disconnect({ targetId }),
      remote.targetId
    )
    await expect
      .poll(async () => (await readSshState(orcaPage, remote.targetId)).status, {
        timeout: 60_000,
        message: 'the SSH target never left the connected state'
      })
      .not.toBe('connected')

    // (a) The gate holds the mount: no guest may exist while routing is unavailable.
    const strandedTab = await createBrowserTab(
      orcaPage,
      worktreeId,
      hostOrigin.url,
      'SSH unavailable'
    )
    const strandedPane = orcaPage.locator(`[data-browser-overlay-tab-id="${strandedTab.id}"]`)
    await expect(
      strandedPane.getByText(SSH_UNAVAILABLE_TITLE),
      'an unreachable SSH host must be classified, not reported as a generic failure'
    ).toBeVisible({ timeout: 180_000 })

    const strandedCensus = await readBrowserPaneMountCensus(orcaPage)
    await testInfo.attach('mount-census-ssh-unavailable', {
      body: JSON.stringify(censusFor(strandedCensus, strandedTab.id), null, 2),
      contentType: 'application/json'
    })
    expect(
      censusFor(strandedCensus, strandedTab.id).filter((entry) => entry.kind === 'webview'),
      'no guest may EVER attach while routing is unavailable, not even briefly'
    ).toEqual([])
    expect(
      censusFor(strandedCensus, strandedTab.id).some(
        (entry) => entry.kind === 'gate-error' && entry.title === SSH_UNAVAILABLE_TITLE
      ),
      'the classified card must be what replaced the preparing card'
    ).toBe(true)

    // (b) The card's affordances. "Try anyway" is deliberately absent: skipping the probe cannot
    // help a host that is not reachable at all, and offering it would invite a pointless retry.
    await expect(strandedPane.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(strandedPane.getByRole('button', { name: BROWSE_LOCALLY_LABEL })).toBeVisible()
    await expect(
      strandedPane.getByRole('button', { name: 'Try anyway' }),
      '"Try anyway" belongs only to the forwarding-blocked card'
    ).toHaveCount(0)

    // (d) The escape hatch, proven by an origin only this device can reach.
    await strandedPane.getByRole('button', { name: BROWSE_LOCALLY_LABEL }).click()
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              window.__store?.getState().settings?.browserSshWorkspaceRoutingDisabledTargetIds ??
              null
          ),
        { timeout: 30_000, message: 'the per-target opt-out never reached the settings store' }
      )
      .toContain(remote.targetId)
    await expect
      .poll(async () => (await probeTabWebview(orcaPage, strandedTab.id))?.marker ?? null, {
        timeout: 120_000,
        intervals: [250, 500, 1_000],
        message: 'the escape hatch never produced a page that could load from this device'
      })
      .toBe(LOCAL_DEVICE_MARKER)
    const escapedPartition = (await probeTabWebview(orcaPage, strandedTab.id))?.partition
    expect(
      escapedPartition,
      'the explicit local-browsing choice must mount off the route partition'
    ).not.toMatch(ROUTE_PARTITION_RE)
    for (const entry of censusFor(await readBrowserPaneMountCensus(orcaPage), strandedTab.id)) {
      if (entry.kind === 'webview') {
        expect(
          entry.partition,
          'the only guest this pane ever attached must be the explicitly unrouted one'
        ).toBe(escapedPartition)
      }
    }

    expect(
      readSshRemoteOnlyRequests(target),
      'nothing may ever reach the container-only origin while the host is unavailable'
    ).toEqual([])
  } finally {
    await hostOrigin?.close()
    cleanupDockerSshRelayTarget(target)
  }
})

/**
 * A real sshd running `AllowTcpForwarding no` — the enterprise policy that leaves the terminal
 * perfectly healthy while making every routed page impossible, and the case the prepare-time
 * forwarding probe exists to explain.
 *
 * The probe classifies on RFC 4254's numeric channel-open reason, which is the only signal that
 * survives the wire. Against this image with ssh2 1.17.0 the two cases it has to separate are:
 *
 *   AllowTcpForwarding no  -> message "(SSH) Channel open failure: open failed",        reason 1
 *   forwarding allowed     -> message "(SSH) Channel open failure: Connection refused", reason 2
 *
 * Neither message contains "administratively prohibited" — that phrase is the OpenSSH *client's*
 * rendering of reason 1 and never travels — so only the code tells them apart. This test is the
 * live proof of that, since no mocked error can be wrong about a format it invents.
 *
 * The tab points at an origin only THIS DEVICE can reach, which makes the "Try anyway" branch
 * decisive: after the override the page must still fail. A silent demotion to local egress would
 * render a marker, and no amount of "it failed either way" could hide it.
 */
test('classifies a real AllowTcpForwarding no refusal and keeps Try anyway routed', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(900_000)
  let target: DockerSshRelayTarget | null = null
  let hostOrigin: { url: string; close: () => Promise<void> } | null = null
  try {
    await waitForSessionReady(orcaPage)
    // Why: the gate's cards are asserted by their user-visible English text.
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })

    hostOrigin = await startHostPublishedOrigin()
    target = startDockerSshRelayTarget(testInfo)
    startSshRemoteOnlyBrowserFixture(target)
    // Refuses to return until a real ssh client confirms the server rejects forwarding.
    blockDockerSshRelayTargetTcpForwarding(target)

    // Connecting at all runs git over SSH, so a green connect is the standing proof that the
    // terminal plane is untouched by the policy — the whole reason this case needs explaining.
    const remote = await connectDockerSshRelayTarget(orcaPage, target)
    expect(
      (await readSshState(orcaPage, remote.targetId)).status,
      'the SSH target itself must stay healthy; only forwarding is denied'
    ).toBe('connected')

    await installBrowserPaneMountCensus(orcaPage)
    const blockedTab = await createBrowserTab(
      orcaPage,
      remote.worktreeId,
      hostOrigin.url,
      'Forwarding blocked'
    )
    const blockedPane = orcaPage.locator(`[data-browser-overlay-tab-id="${blockedTab.id}"]`)

    // The card: classified from the wire reason code, not from prose.
    await expect(
      blockedPane.getByText(FORWARDING_BLOCKED_TITLE),
      'a refused forwarding policy must be classified, not left to opaque per-page SOCKS errors'
    ).toBeVisible({ timeout: 180_000 })
    await expect(
      blockedPane,
      'the card must name the sshd setting an administrator has to change'
    ).toContainText('AllowTcpForwarding no')
    for (const label of ['Retry', 'Try anyway', BROWSE_LOCALLY_LABEL]) {
      await expect(
        blockedPane.getByRole('button', { name: label }),
        `the forwarding-blocked card must offer "${label}"`
      ).toBeVisible()
    }

    const blockedCensus = censusFor(await readBrowserPaneMountCensus(orcaPage), blockedTab.id)
    await testInfo.attach('mount-census-forwarding-blocked', {
      body: JSON.stringify(blockedCensus, null, 2),
      contentType: 'application/json'
    })
    expect(
      blockedCensus.filter((entry) => entry.kind === 'webview'),
      'no guest may attach while the server refuses the forwarding every page needs'
    ).toEqual([])
    expect(
      blockedCensus.some(
        (entry) => entry.kind === 'gate-error' && entry.title === FORWARDING_BLOCKED_TITLE
      ),
      'the classified card must be what replaced the preparing card'
    ).toBe(true)

    // "Try anyway" skips the probe, not the routing — and remembers the choice.
    await blockedPane.getByRole('button', { name: 'Try anyway' }).click()
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            () =>
              window.__store?.getState().settings
                ?.browserSshWorkspaceRoutingProbeSkippedTargetIds ?? null
          ),
        {
          timeout: 30_000,
          message: '"Try anyway" must persist so a vouched-for host is not re-nagged'
        }
      )
      .toContain(remote.targetId)

    await expect
      .poll(async () => (await probeTabWebview(orcaPage, blockedTab.id))?.partition ?? null, {
        timeout: 120_000,
        intervals: [250, 500, 1_000],
        message: '"Try anyway" never mounted a guest'
      })
      .not.toBeNull()
    const overrideCensus = censusFor(await readBrowserPaneMountCensus(orcaPage), blockedTab.id)
    const overrideWebviews = overrideCensus.filter((entry) => entry.kind === 'webview')
    expect(overrideWebviews.length, '"Try anyway" attached no guest to inspect').toBeGreaterThan(0)
    for (const entry of overrideWebviews) {
      if (entry.kind === 'webview') {
        expect(entry.partition, '"Try anyway" must skip the probe, never the routing').toMatch(
          ROUTE_PARTITION_RE
        )
      }
    }

    // The decisive assertion: this URL is reachable from this machine and nowhere else, so a
    // marker here would mean the override had quietly demoted the page to local egress.
    await expect
      .poll(() => readPageLoadError(orcaPage, blockedTab.id), {
        timeout: 180_000,
        intervals: [500, 1_000, 2_000],
        message: 'the page loaded even though the SSH server refuses the forwarding it needs'
      })
      .not.toBeNull()
    await testInfo.attach('try-anyway-load-error', {
      body: JSON.stringify(await readPageLoadError(orcaPage, blockedTab.id)),
      contentType: 'application/json'
    })
    expect(
      (await probeTabWebview(orcaPage, blockedTab.id))?.marker ?? null,
      'the device-only origin rendering would mean the page escaped onto the local network'
    ).toBeNull()
    expect(
      readSshRemoteOnlyRequests(target),
      'nothing may reach the container-only origin either; forwarding is refused in both directions'
    ).toEqual([])
  } finally {
    await hostOrigin?.close()
    cleanupDockerSshRelayTarget(target)
  }
})
