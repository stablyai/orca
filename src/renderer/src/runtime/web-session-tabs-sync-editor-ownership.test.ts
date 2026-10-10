import { beforeEach, describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../../shared/runtime-types'
import type { OpenFile } from '../store/slices/editor'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const filePath = '/repo/readme.txt'
const hostTab: RuntimeMobileSessionFileTab = {
  type: 'file',
  id: 'retained-tab',
  title: 'readme.txt',
  filePath,
  relativePath: 'readme.txt',
  language: 'plaintext',
  isDirty: false,
  isActive: true
}
function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: 'readme.txt',
    worktreeId: WT,
    language: 'plaintext',
    isDirty: false,
    runtimeEnvironmentId: null,
    mode: 'edit',
    ...overrides
  }
}
function snapshot(tabs = [hostTab]) {
  return makeSnapshot(tabs, { activeTabId: hostTab.id, activeTabType: 'file' })
}
const previewTab: RuntimeMobileSessionMarkdownTab = {
  ...hostTab,
  type: 'markdown',
  mode: 'markdown-preview',
  language: 'markdown',
  sourceFileId: filePath,
  sourceFilePath: filePath,
  sourceRelativePath: 'readme.txt',
  documentVersion: 'file:1'
}

describe('host editor file ownership', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('retains an unstamped file until its quiesced ownership migration runs', () => {
    const retained = file({ isDirty: true, pendingOwnerMigration: true })
    const state = makeState({
      openFiles: [retained],
      editorDrafts: { [retained.id]: 'unsaved client edit' },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: hostTab.id,
            entityId: retained.id,
            worktreeId: WT,
            groupId: 'legacy-group',
            executionHostId: 'ssh:legacy-target',
            contentType: 'editor',
            label: 'readme.txt',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW,
            isPreview: false
          }
        ]
      }
    })
    const patch = applyWebSessionTabsSnapshot(state, snapshot(), ENV, NOW)
    expect(patch?.openFiles ?? state.openFiles).toEqual([retained])
    expect((patch?.openFiles ?? state.openFiles)[0]).toBe(retained)
    expect(patch?.unifiedTabsByWorktree?.[WT]?.[0]?.entityId).toBe(retained.id)
  })

  it.each([
    [
      'relay route provenance',
      {
        operationProvenance: {
          generation: {
            route: { executionHostId: 'ssh:legacy-target', runtimeEnvironmentId: null },
            runtimeConnectionGeneration: null,
            runtimePairingRevision: undefined,
            runtimeSshGeneration: null,
            nestedSshGeneration: null,
            directSshGeneration: 1
          },
          ownershipProjection: 'legacy'
        }
      } satisfies Partial<OpenFile>
    ],
    ['an external SSH target', { externalSshTargetId: 'legacy-target' }]
  ])('keeps a dirty in-session file with %s on its tab after conversion', (_, evidence) => {
    const retained = file({ isDirty: true, ...evidence })
    const state = makeState({
      openFiles: [retained],
      editorDrafts: { [retained.id]: 'unsaved client edit' },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: hostTab.id,
            entityId: retained.id,
            worktreeId: WT,
            groupId: 'legacy-group',
            executionHostId: 'ssh:legacy-target',
            contentType: 'editor',
            label: 'readme.txt',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW,
            isPreview: false
          }
        ]
      }
    })
    const patch = applyWebSessionTabsSnapshot(state, snapshot(), ENV, NOW)
    const files = patch?.openFiles ?? state.openFiles
    expect(files).toEqual([retained])
    expect(files[0]).toBe(retained)
    expect(patch?.unifiedTabsByWorktree?.[WT]?.[0]?.entityId).toBe(retained.id)
  })

  it('reuses the file ID produced by ownership migration on later snapshots', () => {
    const owned = file({ id: buildOwnedEditorFileId(filePath, WT, ENV), runtimeEnvironmentId: ENV })
    const state = makeState({ openFiles: [owned] })
    const patch = applyWebSessionTabsSnapshot(state, snapshot(), ENV, NOW)
    expect(patch?.openFiles ?? state.openFiles).toMatchObject([{ id: owned.id }])
    expect(patch?.unifiedTabsByWorktree?.[WT]?.[0]?.entityId).toBe(owned.id)
  })

  it('treats an omitted legacy mode as an editable file', () => {
    const owned = file({
      id: buildOwnedEditorFileId(filePath, WT, ENV),
      runtimeEnvironmentId: ENV,
      mode: undefined
    })
    const state = makeState({ openFiles: [owned] })
    const patch = applyWebSessionTabsSnapshot(state, snapshot(), ENV, NOW)
    expect(patch.openFiles ?? state.openFiles).toMatchObject([{ id: owned.id }])
    expect(patch.unifiedTabsByWorktree?.[WT]?.[0]?.entityId).toBe(owned.id)
  })

  it('shares a pending retained file with a newly published split listed first', () => {
    const retained = file({ isDirty: true, pendingOwnerMigration: true })
    const state = makeState({
      openFiles: [retained],
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: hostTab.id,
            entityId: retained.id,
            worktreeId: WT,
            groupId: 'legacy-group',
            executionHostId: 'ssh:legacy-target',
            contentType: 'editor',
            label: 'readme.txt',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW,
            isPreview: false
          }
        ]
      }
    })
    const patch = applyWebSessionTabsSnapshot(
      state,
      snapshot([{ ...hostTab, id: 'new-split', isActive: false }, hostTab]),
      ENV,
      NOW
    )
    expect(patch.openFiles ?? state.openFiles).toEqual([retained])
    expect(patch.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.entityId)).toEqual([
      retained.id,
      retained.id
    ])
  })

  it('keeps a client draft dirty when a migrated file is republished as clean', () => {
    const owned = file({
      id: buildOwnedEditorFileId(filePath, WT, ENV),
      runtimeEnvironmentId: ENV,
      isDirty: true
    })
    const state = makeState({ openFiles: [owned], editorDrafts: { [owned.id]: 'unsaved draft' } })
    const patch = applyWebSessionTabsSnapshot(state, snapshot(), ENV, NOW)
    expect(patch.openFiles ?? state.openFiles).toMatchObject([{ id: owned.id, isDirty: true }])
  })

  it('links a mirrored preview to its owned source file', () => {
    const owned = file({ id: buildOwnedEditorFileId(filePath, WT, ENV), runtimeEnvironmentId: ENV })
    const patch = applyWebSessionTabsSnapshot(
      makeState({ openFiles: [owned] }),
      makeSnapshot([previewTab]),
      ENV,
      NOW
    )
    expect(patch.openFiles).toMatchObject([
      { id: owned.id },
      { id: `markdown-preview::${owned.id}`, markdownPreviewSourceFileId: owned.id }
    ])
  })

  it('preserves an owned preview’s source ID when only the preview remains open', () => {
    const sourceId = buildOwnedEditorFileId(filePath, WT, ENV)
    const preview = file({
      id: `markdown-preview::${sourceId}`,
      mode: 'markdown-preview',
      runtimeEnvironmentId: ENV,
      markdownPreviewSourceFileId: sourceId
    })
    const state = makeState({ openFiles: [preview] })
    const patch = applyWebSessionTabsSnapshot(state, makeSnapshot([previewTab]), ENV, NOW)
    expect(patch.openFiles ?? state.openFiles).toMatchObject([
      { id: preview.id, markdownPreviewSourceFileId: sourceId }
    ])
  })

  it('does not borrow another host’s disk signature or overwrite its file ID', () => {
    const other = file({ runtimeEnvironmentId: 'other-host', lastKnownDiskSignature: 'other-disk' })
    const patch = applyWebSessionTabsSnapshot(
      makeState({ openFiles: [other] }),
      snapshot(),
      ENV,
      NOW
    )
    expect(patch?.openFiles).toHaveLength(2)
    expect(patch?.openFiles?.[0]).toBe(other)
    expect(patch?.openFiles?.[1]).toMatchObject({
      id: buildOwnedEditorFileId(filePath, WT, ENV),
      runtimeEnvironmentId: ENV
    })
    expect(patch?.openFiles?.[1]?.lastKnownDiskSignature).toBeUndefined()
  })

  it('reserves IDs across workspaces as well as hosts', () => {
    const other = file({ worktreeId: 'another-folder', runtimeEnvironmentId: ENV })
    const patch = applyWebSessionTabsSnapshot(
      makeState({ openFiles: [other] }),
      snapshot(),
      ENV,
      NOW
    )
    expect(patch?.openFiles?.map((entry) => entry.id)).toEqual([
      other.id,
      buildOwnedEditorFileId(filePath, WT, ENV)
    ])
  })

  it('keeps one backing file for two host split tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      snapshot([hostTab, { ...hostTab, id: 'second-split-tab', isActive: false }]),
      ENV,
      NOW
    )
    expect(patch?.openFiles).toHaveLength(1)
    expect(patch?.unifiedTabsByWorktree?.[WT]).toHaveLength(2)
    expect(patch?.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.entityId)).toEqual([
      filePath,
      filePath
    ])
  })
})
