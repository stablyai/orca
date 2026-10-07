import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildOwnedEditorFileId } from '../../src/renderer/src/store/slices/editor/file-ids/editor-file-ids'

test('keeps same-path host models and undo history separate', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = path.join(context.rootPath, `host-model-${randomUUID()}.txt`)
  await writeFile(filePath, 'LOCAL_MARKER', 'utf8')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))
  const remoteId = buildOwnedEditorFileId(filePath, context.worktreeId, 'host-model-fixture')

  // Controlled owner records exercise renderer identity; file transport remains local.
  await orcaPage.evaluate(
    ({ filePath, remoteId, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store unavailable')
      }
      const base = {
        filePath,
        relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
        worktreeId,
        language: 'plaintext',
        mode: 'edit' as const,
        isDirty: true
      }
      const generation = {
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: null
      }
      store.setState((state) => ({
        openFiles: [
          {
            ...base,
            id: filePath,
            operationProvenance: {
              ownershipProjection: 'explicit',
              generation: {
                ...generation,
                route: { executionHostId: 'local', runtimeEnvironmentId: null }
              }
            }
          },
          {
            ...base,
            id: remoteId,
            operationProvenance: {
              ownershipProjection: 'explicit',
              generation: {
                ...generation,
                route: { executionHostId: 'ssh:fixture-target', runtimeEnvironmentId: null }
              }
            }
          }
        ],
        editorDrafts: {
          ...state.editorDrafts,
          [filePath]: 'LOCAL_MARKER',
          [remoteId]: 'REMOTE_MARKER'
        },
        activeFileId: filePath,
        activeFileIdByWorktree: { ...state.activeFileIdByWorktree, [worktreeId]: filePath }
      }))
      const state = store.getState()
      const localTab = state.createUnifiedTab(worktreeId, 'editor', {
        entityId: filePath,
        label: 'Local file'
      })
      state.createUnifiedTab(worktreeId, 'editor', { entityId: remoteId, label: 'Remote file' })
      store.getState().activateTab(localTab.id)
    },
    { filePath, remoteId, worktreeId: context.worktreeId }
  )

  const editor = orcaPage.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 25_000 })
  const valueTail = () => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail)
  await expect.poll(valueTail).toBe('LOCAL_MARKER')
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.type('!')
  await expect.poll(valueTail).toBe('LOCAL_MARKER!')
  await orcaPage.evaluate((id) => window.__store?.getState().setActiveFile(id), remoteId)
  await expect.poll(valueTail).toBe('REMOTE_MARKER')
  await orcaPage.screenshot({ path: testInfo.outputPath('remote-before-undo.png') })
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+z')
  await orcaPage.screenshot({ path: testInfo.outputPath('remote-after-undo.png') })
  await expect.poll(valueTail).toBe('REMOTE_MARKER')
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.type('?')
  await expect.poll(valueTail).toBe('REMOTE_MARKER?')
  await orcaPage.keyboard.press('ControlOrMeta+z')
  await expect.poll(valueTail).toBe('REMOTE_MARKER')
  await orcaPage.evaluate((id) => window.__store?.getState().setActiveFile(id), filePath)
  await expect.poll(valueTail).toBe('LOCAL_MARKER!')
  await orcaPage.screenshot({ path: testInfo.outputPath('local-retained-edit.png') })
})
