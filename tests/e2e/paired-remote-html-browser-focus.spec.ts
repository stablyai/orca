import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  armPairedHtmlPreviewCreationObservation,
  armPairedHtmlPreviewInventoryRpcFailure,
  readPairedHtmlPreviewInventory,
  type PairedHtmlPreviewInventory,
  waitForPairedHtmlPreviewCreationSettlement
} from './helpers/paired-html-preview-inventory'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'paired-html-focus.html'

test('keeps remote HTML preview placement and focuses it only after a click', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>paired html focus</h1></body></html>\n'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'Remote HTML focus')
    const page = client.page
    const worktreeId = await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state
              ? (state.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null)
              : null
          }, testRepoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((repoPath) => {
          const state = window.__store?.getState()
          return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
        }, testRepoPath)
      )
    if (!worktreeId) {
      throw new Error('paired client worktree disappeared after discovery')
    }
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
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
    let browserBaseline: PairedHtmlPreviewInventory | null = null
    await expect
      .poll(
        async () => {
          browserBaseline = await readPairedHtmlPreviewInventory(page, {
            environmentId: client!.environmentId,
            fixtureName: FIXTURE_NAME,
            worktreeId
          })
          return browserBaseline
        },
        { timeout: 30_000, message: 'host browser baseline was never successfully observed' }
      )
      .toMatchObject({ hostResponseError: null, hostResponseOk: true })
    if (!browserBaseline?.hostResponseOk) {
      throw new Error(`host browser baseline failed: ${browserBaseline.hostResponseError}`)
    }
    await armPairedHtmlPreviewCreationObservation(page)
    await openPreviewToSide.click()
    await waitForPairedHtmlPreviewCreationSettlement(page)

    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ environmentId, fixtureName, worktreeId }) => {
              const state = window.__store?.getState()
              if (!state) {
                return null
              }
              const browser = (state.browserTabsByWorktree[worktreeId] ?? []).find((tab) =>
                tab.url.endsWith(`/${fixtureName}`)
              )
              const browserPage = browser
                ? (state.browserPagesByWorkspace[browser.id] ?? [])[0]
                : null
              const handle = browserPage
                ? state.remoteBrowserPageHandlesByPageId[browserPage.id]
                : null
              const response = await window.api.runtimeEnvironments.call({
                selector: environmentId,
                method: 'session.tabs.list',
                params: { worktree: `id:${worktreeId}` },
                timeoutMs: 15_000
              })
              const hostHasHtml =
                response.ok &&
                response.result.tabs.some(
                  (tab) => tab.type === 'browser' && tab.url.endsWith(`/${fixtureName}`)
                )
              return {
                browserRuntimeEnvironmentId: browserPage?.browserRuntimeEnvironmentId ?? null,
                handleEnvironmentId: handle?.environmentId ?? null,
                handleRemotePageId: handle?.remotePageId ?? null,
                hostHasHtml
              }
            },
            { environmentId: client!.environmentId, fixtureName: FIXTURE_NAME, worktreeId }
          ),
        { timeout: 60_000, message: 'remote HTML browser ownership never converged' }
      )
      .toMatchObject({
        browserRuntimeEnvironmentId: client.environmentId,
        handleEnvironmentId: client.environmentId,
        hostHasHtml: true
      })
    let htmlTabInventory: PairedHtmlPreviewInventory | null = null
    let injectedInventoryErrorObserved = false
    let inventoryFailureArmed = false
    let previousSuccessfulInventory: string | null = null
    let stableSuccessfulSnapshots = 0
    await expect
      .poll(
        async () => {
          htmlTabInventory = await readPairedHtmlPreviewInventory(page, {
            environmentId: client!.environmentId,
            fixtureName: FIXTURE_NAME,
            worktreeId
          })
          if (!htmlTabInventory.hostResponseOk) {
            injectedInventoryErrorObserved ||=
              htmlTabInventory.hostResponseError?.includes('e2e_forced_inventory_rpc_failure') ===
              true
            previousSuccessfulInventory = null
            stableSuccessfulSnapshots = 0
          } else {
            if (!inventoryFailureArmed) {
              await armPairedHtmlPreviewInventoryRpcFailure(page)
              inventoryFailureArmed = true
            }
            const fingerprint = JSON.stringify([
              htmlTabInventory.hostPageIds,
              htmlTabInventory.hostTabIds,
              htmlTabInventory.totalHost
            ])
            stableSuccessfulSnapshots =
              fingerprint === previousSuccessfulInventory ? stableSuccessfulSnapshots + 1 : 1
            previousSuccessfulInventory = fingerprint
          }
          return { ...htmlTabInventory, stableSuccessfulSnapshots }
        },
        { timeout: 60_000, message: 'host HTML inventory did not settle successfully' }
      )
      .toMatchObject({
        hostResponseError: null,
        hostResponseOk: true,
        stableSuccessfulSnapshots: 2
      })
    expect(injectedInventoryErrorObserved).toBe(true)
    if (!htmlTabInventory) {
      throw new Error('host HTML inventory disappeared after successful settlement')
    }
    expect(htmlTabInventory.clientWorkspaceIds).toHaveLength(1)
    expect(htmlTabInventory.clientUnifiedTabs).toHaveLength(1)
    expect(htmlTabInventory.hostTabIds).toHaveLength(1)
    expect(htmlTabInventory.clientRemotePageIds).toEqual(htmlTabInventory.hostPageIds)
    expect(htmlTabInventory.totalClientUnified).toBe(browserBaseline.totalClientUnified + 1)
    expect(htmlTabInventory.totalClientWorkspaces).toBe(browserBaseline.totalClientWorkspaces + 1)
    expect(htmlTabInventory.totalHost).toBe(browserBaseline.totalHost + 1)
    expect(htmlTabInventory.clientUnifiedTabs[0]?.groupId).not.toBe(sourceGroupId)
    expect(
      htmlTabInventory.hostTabGroups.some(
        (group) => group.id === htmlTabInventory.clientUnifiedTabs[0]?.groupId
      )
    ).toBe(false)
    const hostBrowserGroupId = htmlTabInventory.hostTabGroups.find((group) =>
      group.tabOrder.includes(htmlTabInventory.hostTabIds[0]!)
    )?.id
    expect(hostBrowserGroupId).toBeTruthy()
    await expect(page.locator(`[data-tab-group-body-id="${sourceGroupId}"]`)).toBeVisible()
    await expect(
      page.locator(`[data-tab-group-body-id="${htmlTabInventory.clientUnifiedTabs[0]!.groupId}"]`)
    ).toBeVisible()
    await expect(page.getByTestId('remote-browser-frame')).toBeVisible({ timeout: 60_000 })

    const previewFocus = await page.evaluate(
      ({ sourceGroupId, sourceTabId, worktreeId: targetWorktreeId }) => {
        const state = window.__store?.getState()
        const activeGroup = (state?.groupsByWorktree[targetWorktreeId] ?? []).find(
          (group) => group.id === state?.activeGroupIdByWorktree[targetWorktreeId]
        )
        return {
          activeGroupId: activeGroup?.id ?? null,
          activeTabId: activeGroup?.activeTabId ?? null,
          activeTabType: state?.activeTabTypeByWorktree[targetWorktreeId] ?? null,
          sourceGroupId,
          sourceTabId
        }
      },
      { sourceGroupId, sourceTabId: sourceEditor.tabId, worktreeId }
    )
    expect(previewFocus).toEqual({
      activeGroupId: sourceGroupId,
      activeTabId: sourceEditor.tabId,
      activeTabType: 'editor',
      sourceGroupId,
      sourceTabId: sourceEditor.tabId
    })

    const tabIds = await page.evaluate(
      ({ fixtureName, worktreeId: targetWorktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          return null
        }
        const terminalId = state.tabsByWorktree[targetWorktreeId]?.[0]?.id ?? null
        const browserId = (state.browserTabsByWorktree[targetWorktreeId] ?? []).find((tab) =>
          tab.url.endsWith(`/${fixtureName}`)
        )?.id
        return terminalId && browserId ? { browserId, terminalId } : null
      },
      { fixtureName: FIXTURE_NAME, worktreeId }
    )
    if (!tabIds) {
      throw new Error('paired client did not retain both terminal and HTML browser tabs')
    }
    await page.locator(`[data-tab-id="${tabIds.terminalId}"]`).click()
    await expect
      .poll(
        () =>
          page.evaluate((targetWorktreeId) => {
            const state = window.__store?.getState()
            return state?.activeTabTypeByWorktree[targetWorktreeId] ?? null
          }, worktreeId),
        { message: 'terminal tab never became active before the browser click' }
      )
      .toBe('terminal')
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ environmentId, worktreeId }) => {
              const response = await window.api.runtimeEnvironments.call({
                selector: environmentId,
                method: 'session.tabs.list',
                params: { worktree: `id:${worktreeId}` },
                timeoutMs: 15_000
              })
              if (!response.ok) {
                return false
              }
              return (
                response.result.tabs.find((tab) => tab.id === response.result.activeTabId)?.type ===
                'terminal'
              )
            },
            { environmentId: client.environmentId, worktreeId }
          ),
        { timeout: 30_000, message: 'host never accepted terminal activation' }
      )
      .toBe(true)
    const hostBrowserTab = htmlTabInventory.hostTabs[0]
    if (!hostBrowserTab?.browserPageId) {
      throw new Error('host HTML browser tab disappeared before activation')
    }
    const clientRemotePageId = await page.evaluate(
      ({ fixtureName, worktreeId }) => {
        const state = window.__store?.getState()
        const workspace = (state?.browserTabsByWorktree[worktreeId] ?? []).find((tab) =>
          tab.url.endsWith(`/${fixtureName}`)
        )
        const browserPage = workspace
          ? (state?.browserPagesByWorkspace[workspace.id] ?? [])[0]
          : null
        return browserPage
          ? (state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.remotePageId ?? null)
          : null
      },
      { fixtureName: FIXTURE_NAME, worktreeId }
    )
    expect(clientRemotePageId).toBe(hostBrowserTab.browserPageId)
    const content = await page.evaluate(
      async ({ browserPageId, environmentId, worktreeId }) =>
        window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'browser.eval',
          params: {
            worktree: `id:${worktreeId}`,
            page: browserPageId,
            expression: 'document.querySelector("h1")?.textContent'
          },
          timeoutMs: 15_000
        }),
      {
        browserPageId: hostBrowserTab.browserPageId,
        environmentId: client.environmentId,
        worktreeId
      }
    )
    expect(content).toMatchObject({ ok: true, result: { result: 'paired html focus' } })
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ browserTabId, environmentId }) => {
              const state = window.__store?.getState()
              return (state?.browserPagesByWorkspace[browserTabId] ?? []).some((browserPage) => {
                const handle = state?.remoteBrowserPageHandlesByPageId[browserPage.id]
                return (
                  handle?.environmentId === environmentId ||
                  browserPage.browserRuntimeEnvironmentId === environmentId
                )
              })
            },
            { browserTabId: tabIds.browserId, environmentId: client.environmentId }
          ),
        { timeout: 30_000, message: 'client lost remote browser ownership before activation' }
      )
      .toBe(true)
    await page.locator(`[data-tab-id="${tabIds.browserId}"]`).click()

    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ environmentId, fixtureName, worktreeId }) => {
              const state = window.__store?.getState()
              if (!state) {
                return null
              }
              const response = await window.api.runtimeEnvironments.call({
                selector: environmentId,
                method: 'session.tabs.list',
                params: { worktree: `id:${worktreeId}` },
                timeoutMs: 15_000
              })
              const activeGroup = (state.groupsByWorktree[worktreeId] ?? []).find(
                (group) => group.id === state.activeGroupIdByWorktree[worktreeId]
              )
              const activeUnified = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
                (tab) => tab.id === activeGroup?.activeTabId
              )
              const hostActive = response.ok
                ? response.result.tabs.find((tab) => tab.id === response.result.activeTabId)
                : null
              return {
                activeGroupType: activeUnified?.contentType ?? null,
                activeTabType: state.activeTabTypeByWorktree[worktreeId] ?? null,
                hostActiveHtml:
                  hostActive?.type === 'browser' && hostActive.url.endsWith(`/${fixtureName}`)
              }
            },
            { environmentId: client!.environmentId, fixtureName: FIXTURE_NAME, worktreeId }
          ),
        { timeout: 30_000, message: 'browser click did not remain authoritative' }
      )
      .toEqual({ activeGroupType: 'browser', activeTabType: 'browser', hostActiveHtml: true })
    await expect(page.getByTestId('remote-browser-frame')).toBeVisible()

    const browserTab = page.locator(`[data-tab-id="${tabIds.browserId}"]`)
    await browserTab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({
              environmentId,
              hostTabId,
              sourceGroupId,
              unifiedTabId,
              workspaceId,
              worktreeId
            }) => {
              const state = window.__store?.getState()
              const response = await window.api.runtimeEnvironments.call({
                selector: environmentId,
                method: 'session.tabs.list',
                params: { worktree: `id:${worktreeId}` },
                timeoutMs: 15_000
              })
              return {
                clientUnifiedPresent: (state?.unifiedTabsByWorktree[worktreeId] ?? []).some(
                  (tab) => tab.id === unifiedTabId
                ),
                clientWorkspacePresent: (state?.browserTabsByWorktree[worktreeId] ?? []).some(
                  (tab) => tab.id === workspaceId
                ),
                hostTabPresent: response.ok
                  ? response.result.tabs.some((tab) => tab.id === hostTabId)
                  : true,
                sourceGroupPresent: (state?.groupsByWorktree[worktreeId] ?? []).some(
                  (group) => group.id === sourceGroupId
                )
              }
            },
            {
              environmentId: client!.environmentId,
              hostTabId: hostBrowserTab.id,
              sourceGroupId,
              unifiedTabId: htmlTabInventory.clientUnifiedTabs[0]!.id,
              workspaceId: htmlTabInventory.clientWorkspaceIds[0]!,
              worktreeId
            }
          ),
        { timeout: 30_000, message: 'remote HTML browser close did not converge cleanly' }
      )
      .toEqual({
        clientUnifiedPresent: false,
        clientWorkspacePresent: false,
        hostTabPresent: false,
        sourceGroupPresent: true
      })
    await expect(browserTab).toHaveCount(0)
    await expect(page.locator(`[data-tab-id="${tabIds.terminalId}"]`)).toBeVisible()
    await expect(page.locator(`[data-tab-id="${sourceEditor.tabId}"]`)).toBeVisible()
    await expect(
      page.locator(`[data-tab-group-body-id="${sourceGroupId}"] .monaco-editor`)
    ).toBeVisible()
  } finally {
    await client?.dispose()
  }
})
