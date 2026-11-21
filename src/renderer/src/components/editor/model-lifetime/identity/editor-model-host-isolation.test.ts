// @vitest-environment happy-dom
import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/store/slices/editor/create-editor-slice'
import { buildOwnedEditorFileId } from '@/store/slices/editor/file-ids/editor-file-ids'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { WorktreeOperationRoute } from '@/lib/workspace/ownership/worktree-operation-route'
import {
  attachModelLifetimeView,
  createModelLifetimeFixture,
  modelLifetimeFile,
  modelLifetimeTextModel,
  resetModelLifetimeFixtures
} from '../retention/editor-model-lifetime-fixture'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'
import { resetProgrammaticContentSyncForTests } from '../buffer-text/monaco-programmatic-sync'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

const FILE_PATH = '/fixture/workspace/same-path.txt'
const HOSTS: readonly WorktreeOperationRoute[] = [
  { executionHostId: 'local', runtimeEnvironmentId: null },
  { executionHostId: 'ssh:target', runtimeEnvironmentId: null },
  { executionHostId: 'runtime:hub-a', runtimeEnvironmentId: 'hub-a' },
  { executionHostId: 'ssh:target', runtimeEnvironmentId: 'hub-a' },
  { executionHostId: 'ssh:target', runtimeEnvironmentId: 'hub-b' }
]

function file(id: string, route: WorktreeOperationRoute, filePath = FILE_PATH): OpenFile {
  return {
    ...modelLifetimeFile(id),
    filePath,
    relativePath: 'same-path.txt',
    runtimeEnvironmentId: route.runtimeEnvironmentId,
    operationProvenance: {
      ownershipProjection: 'explicit',
      generation: {
        route,
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: null
      }
    }
  }
}

function createHostModels(filePath = FILE_PATH) {
  const fixture = createModelLifetimeFixture()
  const owners = HOSTS.map((route, index) => {
    const ownedFile = file(`host-${index}`, route, filePath)
    const modelKey = toEditorModelUri(
      ownedFile.filePath,
      getEditorModelOwnerKey(ownedFile, fixture.store.getState())
    )
    const initial = `text owned by ${route.executionHostId} through ${route.runtimeEnvironmentId}`
    const model = modelLifetimeTextModel(modelKey, initial)
    return { file: ownedFile, model, modelKey, initial }
  })
  fixture.store.setState({ openFiles: owners.map((owner) => owner.file) })
  return { ...fixture, owners }
}

function edit(model: monaco.editor.ITextModel, text: string) {
  model.pushStackElement()
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
  model.pushStackElement()
}

afterEach(() => {
  resetProgrammaticContentSyncForTests()
  resetModelLifetimeFixtures()
})

describe('same-path models on different execution hosts', () => {
  it('closes only the selected host model while siblings retain their text and undo', async () => {
    const { owners, store, attach } = createHostModels()
    owners.forEach((owner, index) => edit(owner.model, `edited host ${index}`))
    attach()
    for (const [index, owner] of owners.entries()) {
      store.getState().closeFile(owner.file.id)
      await Promise.resolve()
      expect(owner.model.isDisposed()).toBe(true)
      for (const [siblingIndex, sibling] of owners.slice(index + 1).entries()) {
        expect(sibling.model.isDisposed()).toBe(false)
        expect(sibling.model.getValue()).toBe(`edited host ${index + siblingIndex + 1}`)
        expect(sibling.model.canUndo()).toBe(true)
      }
    }
    expect(store.getState().openFiles).toHaveLength(0)
  })

  it.each([FILE_PATH, 'C:\\fixture\\workspace\\same-path.txt', '\\\\server\\share\\same-path.txt'])(
    'restores independent closed-tab undo for remote owners of %s',
    async (filePath) => {
      const { owners, store, attach } = createHostModels(filePath)
      const remoteOwners = [owners[1], owners[4]]
      attach()
      const closed = remoteOwners.map((owner, index) => {
        if (!owner) {
          throw new Error('Missing remote owner')
        }
        edit(owner.model, `saved remote draft ${index}`)
        return { ...owner, saved: owner.model.getValue() }
      })
      for (const owner of closed) {
        store.getState().closeFile(owner.file.id)
      }
      await Promise.resolve()
      expect(closed.every((owner) => owner.model.isDisposed())).toBe(true)
      store.setState({
        openFiles: [...store.getState().openFiles, ...closed.map((owner) => owner.file)]
      })
      const reopened = closed.map((owner) => modelLifetimeTextModel(owner.modelKey, owner.saved))
      expect(reopened.every((model) => model.canUndo())).toBe(true)
      for (const [index, model] of reopened.entries()) {
        await model.undo()
        expect(reopened.map((candidate) => candidate.getValue())).toEqual(
          closed.map((owner, ownerIndex) => (ownerIndex <= index ? owner.initial : owner.saved))
        )
      }
      for (const owner of owners.filter(
        (candidate) => !closed.some((entry) => entry.file.id === candidate.file.id)
      )) {
        expect(owner.model.isDisposed()).toBe(false)
        expect(owner.model.getValue()).toBe(owner.initial)
      }
    }
  )

  it('preserves local same-path sharing until the final local tab closes', async () => {
    const { owners, store, attach } = createHostModels()
    const local = owners[0]!
    const sharedLocal = {
      ...local.file,
      id: 'local-other-workspace',
      worktreeId: 'another-workspace'
    }
    store.setState({ openFiles: [...store.getState().openFiles, sharedLocal] })
    attach()
    edit(local.model, 'shared local edit')
    store.getState().closeFile(local.file.id)
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(false)
    await local.model.undo()
    expect(local.model.getValue()).toBe(local.initial)
    store.getState().closeFile(sharedLocal.id)
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(true)
    expect(owners.slice(1).every((owner) => !owner.model.isDisposed())).toBe(true)
  })

  it('releases an attached old owner when the same tab moves to a live runtime model', async () => {
    const { owners, store, attach } = createHostModels()
    const local = owners[0]!
    const runtime = owners[2]!
    const migratedFile: OpenFile = {
      ...local.file,
      id: buildOwnedEditorFileId(FILE_PATH, local.file.worktreeId, 'hub-a'),
      runtimeEnvironmentId: 'hub-a',
      operationProvenance: runtime.file.operationProvenance
    }
    const detach = attachModelLifetimeView(local.model)
    edit(runtime.model, 'runtime independent edit')
    attach()
    store.setState({
      openFiles: store
        .getState()
        .openFiles.map((opened) =>
          opened.id === local.file.id
            ? migratedFile
            : opened.id === runtime.file.id
              ? { ...opened, readOnly: true }
              : opened
        )
    })
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(false)
    detach()
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(true)
    expect(runtime.model.isDisposed()).toBe(false)
    expect(runtime.model.getValue()).toBe('runtime independent edit')
    store.getState().closeFile(migratedFile.id)
    await Promise.resolve()
    expect(store.getState().openFiles.some((opened) => opened.id === runtime.file.id)).toBe(true)
    expect(runtime.model.isDisposed()).toBe(false)
    await runtime.model.undo()
    expect(runtime.model.getValue()).toBe(runtime.initial)
  })

  it('releases the prior owner when an uncaptured tab changes host without changing the tab array', async () => {
    const { owners, store, attach } = createHostModels()
    const local = owners[0]!
    const ssh = owners[1]!
    const legacyFile = { ...local.file, operationProvenance: undefined }
    store.setState({ openFiles: [legacyFile, ...owners.slice(1).map((owner) => owner.file)] })
    const detach = attachModelLifetimeView(local.model)
    attach()
    store.setState({
      worktreesByRepo: Object.fromEntries(
        Object.entries(store.getState().worktreesByRepo).map(([repoId, worktrees]) => [
          repoId,
          worktrees.map((worktree) => ({ ...worktree, hostId: 'ssh:target' as const }))
        ])
      )
    })
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(false)
    detach()
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(true)
    expect(ssh.model.isDisposed()).toBe(false)
    expect(ssh.model.getValue()).toBe(ssh.initial)
  })

  it('uses prior host ownership when a catalog and its uncaptured tab disappear together', async () => {
    const { owners, store, attach } = createHostModels()
    const local = owners[0]!
    const legacyFile = { ...local.file, operationProvenance: undefined }
    store.setState({ openFiles: [legacyFile, ...owners.slice(1).map((owner) => owner.file)] })
    attach()
    store.setState({ openFiles: owners.slice(1).map((owner) => owner.file), worktreesByRepo: {} })
    await Promise.resolve()
    expect(local.model.isDisposed()).toBe(true)
    for (const owner of owners.slice(1)) {
      expect(owner.model.isDisposed()).toBe(false)
      expect(owner.model.getValue()).toBe(owner.initial)
    }
  })
})
