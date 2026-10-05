import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import './helpers/runtime-types'
import { getActiveWorktreeContext, openMarkdownFixture } from './helpers/markdown-editor-fixture'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const ORIGINAL = '# Inactive Markdown\n\nOriginal desktop text.\n'
const REPLACEMENT = '# Inactive Markdown\n\nSaved from the paired client.\n'

test('paired Markdown read and save preserve the desktop-active split', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const markdownPath = path.join(testRepoPath, 'inactive-mobile.md')
  const siblingPath = path.join(testRepoPath, 'active-sibling.txt')
  writeFileSync(markdownPath, ORIGINAL)
  writeFileSync(siblingPath, 'Desktop-active sibling\n')
  await orcaPage.waitForFunction(
    () =>
      window.__store?.getState().workspaceSessionReady === true &&
      Boolean(window.__store.getState().activeWorktreeId)
  )
  const context = await getActiveWorktreeContext(orcaPage)
  await openMarkdownFixture(orcaPage, context, markdownPath)
  await expect(orcaPage.locator('.rich-markdown-editor h1')).toHaveText('Inactive Markdown')
  const tabs = await orcaPage.evaluate(
    ({ worktreeId, markdownPath, siblingPath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Missing test store')
      }
      const markdownFile = store.getState().openFiles.find((file) => file.filePath === markdownPath)
      const markdownTab = store
        .getState()
        .unifiedTabsByWorktree[worktreeId]?.find(
          (tab) => tab.contentType === 'editor' && tab.entityId === markdownFile?.id
        )
      if (!markdownTab) {
        throw new Error('Missing Markdown tab')
      }
      const siblingGroupId = store
        .getState()
        .createEmptySplitGroup(worktreeId, markdownTab.groupId, 'right', { activate: true })
      if (!siblingGroupId) {
        throw new Error('Could not create sibling split')
      }
      store.getState().openFile({
        worktreeId,
        filePath: siblingPath,
        relativePath: 'active-sibling.txt',
        language: 'plaintext',
        mode: 'edit'
      })
      const siblingFile = store.getState().openFiles.find((file) => file.filePath === siblingPath)
      const siblingTab = store
        .getState()
        .unifiedTabsByWorktree[worktreeId]?.find(
          (tab) => tab.contentType === 'editor' && tab.entityId === siblingFile?.id
        )
      if (!siblingTab) {
        throw new Error('Missing sibling tab')
      }
      store.getState().focusGroup(worktreeId, siblingGroupId)
      return { markdownTabId: markdownTab.id, siblingTabId: siblingTab.id, siblingGroupId }
    },
    { worktreeId: context.worktreeId, markdownPath, siblingPath }
  )
  const siblingStrip = orcaPage.locator(`[data-tab-group-strip-id="${tabs.siblingGroupId}"]`)
  const markdownTab = orcaPage.locator(`[data-tab-id="${tabs.markdownTabId}"]`)
  const siblingTab = orcaPage.locator(`[data-tab-id="${tabs.siblingTabId}"]`)
  await expect(
    siblingStrip.getByRole('button', { name: 'Pane Actions', exact: true })
  ).toBeVisible()
  await expect(markdownTab).toHaveAttribute('data-active', 'true')
  await expect(siblingTab).toHaveAttribute('data-active', 'true')
  await expect(orcaPage.locator('.monaco-editor .view-lines').first()).toContainText(
    'Desktop-active sibling'
  )
  let client: PairedElectronClient | undefined
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'Inactive split Markdown proof'
    )
    const read = await client.page.evaluate(
      async ({ environmentId, worktreeId, tabId }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'markdown.readTab',
          params: { worktree: `id:${worktreeId}`, tabId }
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        const result = response.result
        if (
          !result ||
          typeof result !== 'object' ||
          !('content' in result) ||
          typeof result.content !== 'string' ||
          !('version' in result) ||
          typeof result.version !== 'string'
        ) {
          throw new Error('Invalid Markdown read result')
        }
        return { content: result.content, version: result.version }
      },
      {
        environmentId: client.environmentId,
        worktreeId: context.worktreeId,
        tabId: tabs.markdownTabId
      }
    )
    expect(read.content).toBe(ORIGINAL)
    await client.page.evaluate(
      async ({ environmentId, worktreeId, tabId, baseVersion, content }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'markdown.saveTab',
          params: { worktree: `id:${worktreeId}`, tabId, baseVersion, content }
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
      },
      {
        environmentId: client.environmentId,
        worktreeId: context.worktreeId,
        tabId: tabs.markdownTabId,
        baseVersion: read.version,
        content: REPLACEMENT
      }
    )
    await expect.poll(() => readFileSync(markdownPath, 'utf8')).toBe(REPLACEMENT)
    await expect(orcaPage.locator('.rich-markdown-editor')).toContainText(
      'Saved from the paired client.'
    )
    await expect(
      siblingStrip.getByRole('button', { name: 'Pane Actions', exact: true })
    ).toBeVisible()
    await expect(markdownTab).toHaveAttribute('data-active', 'true')
    await expect(siblingTab).toHaveAttribute('data-active', 'true')
    await expect(orcaPage.locator('.monaco-editor .view-lines').first()).toContainText(
      'Desktop-active sibling'
    )
    await testInfo.attach('paired-save-preserves-desktop-split', {
      body: await orcaPage.screenshot({
        path: testInfo.outputPath('paired-save-preserves-desktop-split.png')
      }),
      contentType: 'image/png'
    })
  } finally {
    await client?.dispose()
  }
})
