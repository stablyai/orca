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

  // Both tabs open through the user's open path, so a layout-owner build's main holds them too.
  // The second owner is keyed apart by a runtime id, then its record is pointed back at the
  // fixture's SSH route with local transport before it first loads (it opens unselected).
  const openedIds = await orcaPage.evaluate(
    ({ filePath, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store unavailable')
      }
      const generation = {
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: null
      }
      const provenance = (
        executionHostId: 'local' | 'ssh:fixture-target',
        runtimeEnvironmentId: string | null
      ) => ({
        ownershipProjection: 'explicit' as const,
        generation: { ...generation, route: { executionHostId, runtimeEnvironmentId } }
      })
      const file = {
        filePath,
        relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
        worktreeId,
        language: 'plaintext',
        mode: 'edit' as const
      }
      const localId = store.getState().openFile({
        ...file,
        runtimeEnvironmentId: null,
        operationProvenance: provenance('local', null)
      })
      const remoteId = store.getState().openFile(
        {
          ...file,
          runtimeEnvironmentId: 'host-model-fixture',
          operationProvenance: provenance('ssh:fixture-target', 'host-model-fixture')
        },
        { selection: 'none' }
      )
      store.setState((state) => ({
        openFiles: state.openFiles.map((entry) =>
          entry.id === remoteId
            ? {
                ...entry,
                isDirty: true,
                runtimeEnvironmentId: undefined,
                operationProvenance: provenance('ssh:fixture-target', null)
              }
            : entry.id === localId
              ? { ...entry, isDirty: true }
              : entry
        ),
        editorDrafts: {
          ...state.editorDrafts,
          [localId]: 'LOCAL_MARKER',
          [remoteId]: 'REMOTE_MARKER'
        }
      }))
      store.getState().setActiveFile(localId)
      return { localId, remoteId }
    },
    { filePath, worktreeId: context.worktreeId }
  )
  expect(openedIds).toEqual({ localId: filePath, remoteId })

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
