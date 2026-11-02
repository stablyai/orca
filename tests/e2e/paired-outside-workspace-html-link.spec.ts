import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { readDocPreviewRenderedText } from './helpers/paired-html-preview-inventory'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { openTerminalWorkspaceRootLink } from './helpers/terminal-workspace-root-link'

test.use({ orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('opens an unregistered host HTML path from a terminal and keeps asset access scoped', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  // Boots a paired hub and client, then opens two documents and approves their asset folders.
  test.setTimeout(240_000)
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-outside-html-')))
  const filePath = path.join(directory, 'proposal.html')
  const workspaceAssetReport = path.join(
    path.dirname(testRepoPath),
    `${path.basename(directory)}.html`
  )
  writeFileSync(
    filePath,
    '<title>Unregistered HTML</title><h1>Unregistered host document</h1>' +
      '<p id="asset">not granted</p><script src="./asset.js"></script>' +
      '<style>@font-face{font-family:PreviewFont;src:url("./font.woff2")}</style>' +
      '<p id="font">font waiting</p><script>document.fonts.load("12px PreviewFont")' +
      '.then(fonts=>{document.querySelector("#font").textContent=fonts.length?"font loaded":"font missing"})' +
      '.catch(()=>{document.querySelector("#font").textContent="font blocked"})</script>'
  )
  copyFileSync(
    path.resolve('src/renderer/src/assets/fonts/Geist-Variable.woff2'),
    path.join(directory, 'font.woff2')
  )
  writeFileSync(
    path.join(directory, 'asset.js'),
    'document.querySelector("#asset").textContent = "approved asset loaded"'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'Unregistered HTML host')
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (root) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((item) => item.path === root),
            testRepoPath
          ),
        { timeout: 120_000 }
      )
      .toBe(true)
    const worktreeId = await client.page.evaluate(
      async ({ root, environmentId }) => {
        const state = window.__store?.getState()
        const workspace = state?.allWorktrees().find((item) => item.path === root)
        if (!state || !workspace) {
          throw new Error('Missing source workspace')
        }
        await state.updateSettings({ terminalLinkClickBehavior: 'actions' })
        state.setActiveWorktree(workspace.id, `runtime:${environmentId}`)
        return workspace.id
      },
      { root: testRepoPath, environmentId: client.environmentId }
    )
    await ensureTerminalVisible(client.page)
    await waitForActiveTerminalManager(client.page)
    const terminalTabId = await client.page.evaluate(() => window.__store?.getState().activeTabId)
    if (!terminalTabId) {
      throw new Error('Missing source terminal')
    }

    await openTerminalWorkspaceRootLink(client.page, testInfo, filePath)
    const popup = client.page.locator('[data-link-action-popover]')
    await popup.getByRole('button', { name: 'Open file', exact: false }).click()
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, 'h1'))
      .toBe('Unregistered host document')
    await expect.poll(() => readDocPreviewRenderedText(client.page, '#asset')).toBe('not granted')
    await expect(
      client.page.getByRole('status').filter({ hasText: 'This preview wants to read' })
    ).toContainText(directory)
    await client.page.getByRole('button', { name: 'Allow folder', exact: true }).click()
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, '#asset'))
      .toBe('approved asset loaded')
    await expect.poll(() => readDocPreviewRenderedText(client.page, '#font')).toBe('font loaded')

    const document = await client.page.evaluate(
      ({ worktreeId, filePath, directory }) => {
        const state = window.__store?.getState()
        return {
          location: state?.browserTabsByWorktree[worktreeId]?.find(
            (tab) => tab.docLocation?.filePath === filePath
          )?.docLocation,
          registered: state?.allWorktrees().some((item) => item.path === directory)
        }
      },
      { worktreeId, filePath, directory }
    )
    expect(document).toEqual({
      location: { kind: 'workspace-doc', worktreeId, filePath },
      registered: false
    })
    await client.page.screenshot({
      path: testInfo.outputPath('unregistered-host-html-preview.png')
    })

    const workspaceAssetName = 'outside-doc-asset.js'
    writeFileSync(
      path.join(testRepoPath, workspaceAssetName),
      'document.querySelector("#asset").textContent="workspace asset loaded"'
    )
    writeFileSync(
      workspaceAssetReport,
      '<h1>Outside report with workspace assets</h1><p id="asset">not granted</p>' +
        `<script src="./${path.basename(testRepoPath)}/${workspaceAssetName}"></script>`
    )
    await client.page.evaluate(
      ({ worktreeId, filePath }) => {
        window.__store?.getState().createBrowserTab(worktreeId, 'data:text/html,', {
          docLocation: { kind: 'workspace-doc', worktreeId, filePath },
          browserRuntimeEnvironmentId: null,
          activate: true
        })
      },
      { worktreeId, filePath: workspaceAssetReport }
    )
    await expect
      .poll(() =>
        readDocPreviewRenderedText(client.page, 'h1', path.basename(workspaceAssetReport))
      )
      .toBe('Outside report with workspace assets')
    await expect(
      client.page.getByRole('status').filter({ hasText: 'This preview wants to read' })
    ).toContainText(path.basename(testRepoPath))
    await client.page.getByRole('button', { name: 'Allow folder', exact: true }).click()
    await expect
      .poll(() =>
        readDocPreviewRenderedText(client.page, '#asset', path.basename(workspaceAssetReport))
      )
      .toBe('workspace asset loaded')

    await client.page.locator(`[data-tab-id="${terminalTabId}"]`).click()
    await openTerminalWorkspaceRootLink(client.page, testInfo, filePath, 'open')
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, 'h1', 'proposal.html'))
      .toBe('Unregistered host document')
  } finally {
    await client.dispose()
    rmSync(workspaceAssetReport, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})
