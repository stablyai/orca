import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { buildWorkspaceSessionPatch } from '@/lib/workspace-session-patch'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { parkRecoveredEditorDrafts } from './editor/actions/parked-recovered-editor-drafts'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/worktree-operation-generation'
import type { ClosedEditorTabSnapshot } from './editor/types/open-file'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createStoreSessionMockApi()

const WORKSPACE = 'folder:recovery'
function draft(index: number): ClosedEditorTabSnapshot {
  return {
    filePath: `/workspace/draft-${index}.ts`,
    relativePath: `draft-${index}.ts`,
    worktreeId: WORKSPACE,
    language: 'typescript',
    mode: 'edit',
    runtimeEnvironmentId: 'removed-host',
    externalSshTargetId: 'ssh-owner',
    dirtyDraftContent: index === 0 ? '' : `unsaved ${index}`,
    lastKnownDiskSignature: `baseline-${index}`
  }
}

describe('durable editor recovery', () => {
  it.each([false, true])('does not reuse a captured SSH rival when dirty=%s', (isDirty) => {
    const store = createTestStore()
    const snapshot = { ...draft(1), runtimeEnvironmentId: null, externalSshTargetId: 'target-a' }
    const rival = {
      ...snapshot,
      id: 'rival',
      isDirty,
      externalSshTargetId: undefined,
      operationProvenance: {
        ownershipProjection: 'explicit' as const,
        generation: captureWorktreeOperationGenerationSnapshot({
          executionHostId: 'ssh:target-b',
          runtimeEnvironmentId: null
        })
      }
    }
    const open = vi.fn(() => 'rival')
    store.setState({
      openFiles: [rival],
      editorDrafts: isDirty ? { rival: 'rival text' } : {},
      recentlyClosedEditorTabsByWorktree: { [WORKSPACE]: [snapshot] },
      openFile: open
    })
    expect(store.getState().reopenClosedEditorTab(WORKSPACE)).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(store.getState().openFiles).toEqual([rival])
    expect(store.getState().recentlyClosedEditorTabsByWorktree[WORKSPACE]).toContainEqual(snapshot)
  })

  it('persists a recovered draft under its captured SSH owner rather than stale fields', () => {
    const store = createTestStore()
    const snapshot = {
      ...draft(1),
      operationProvenance: {
        ownershipProjection: 'explicit' as const,
        generation: captureWorktreeOperationGenerationSnapshot({
          executionHostId: 'ssh:target',
          runtimeEnvironmentId: 'hub'
        })
      }
    }
    store.setState(parkRecoveredEditorDrafts(store.getState(), WORKSPACE, [snapshot]))
    expect(
      buildWorkspaceSessionPayload(store.getState()).recoveredEditorDraftsByWorktree?.[
        WORKSPACE
      ]?.[0]
    ).toMatchObject({
      runtimeEnvironmentId: 'hub',
      externalSshTargetId: 'target',
      dirtyDraftContent: snapshot.dirtyDraftContent
    })
  })

  it('retains every buffer and its authority through serialization and fresh-store hydration', () => {
    const store = createTestStore()
    const originals = Array.from({ length: 42 }, (_value, index) => draft(index))
    store.setState(parkRecoveredEditorDrafts(store.getState(), WORKSPACE, originals))
    const payload = buildWorkspaceSessionPayload(store.getState())
    const parsed = parseWorkspaceSession(JSON.parse(JSON.stringify(payload)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('session did not parse')
    }
    const restarted = createTestStore()
    restarted.getState().hydrateEditorSession(parsed.value)
    const recovered = restarted.getState().recentlyClosedEditorTabsByWorktree[WORKSPACE]
    expect(
      recovered.map((entry) => [
        entry.dirtyDraftContent,
        entry.lastKnownDiskSignature,
        entry.runtimeEnvironmentId,
        entry.externalSshTargetId
      ])
    ).toEqual(
      originals.map((entry) => [
        entry.dirtyDraftContent,
        entry.lastKnownDiskSignature,
        entry.runtimeEnvironmentId,
        entry.externalSshTargetId
      ])
    )
    // Missing workspace inventory cannot erase a recovery copy.
    restarted.getState().hydrateEditorSession(parsed.value)
    expect(restarted.getState().recentlyClosedEditorTabsByWorktree[WORKSPACE]).toHaveLength(42)
    expect(
      buildWorkspaceSessionPayload(restarted.getState()).recoveredEditorDraftsByWorktree
    ).toEqual(payload.recoveredEditorDraftsByWorktree)
  })

  it('writes recovery additions and consumption through the incremental writer', () => {
    const store = createTestStore()
    store.setState(parkRecoveredEditorDrafts(store.getState(), WORKSPACE, [draft(0)]))
    const added = buildWorkspaceSessionPatch(store.getState(), [
      'recentlyClosedEditorTabsByWorktree'
    ])
    expect(added.recoveredEditorDraftsByWorktree?.[WORKSPACE]?.[0]?.dirtyDraftContent).toBe('')
    store.setState({ recentlyClosedEditorTabsByWorktree: {} })
    expect(
      buildWorkspaceSessionPatch(store.getState(), ['recentlyClosedEditorTabsByWorktree'])
        .recoveredEditorDraftsByWorktree
    ).toEqual({})
  })

  it('reaches recovery after cross-type history expires without reviving ordinary old closes', () => {
    const store = createTestStore()
    const recovered = draft(1)
    const { dirtyDraftContent: _draft, ...saved } = draft(2)
    store.setState({
      recentlyClosedEditorTabsByWorktree: { [WORKSPACE]: [saved, recovered] },
      recentlyClosedTabKindsByWorktree: {},
      reopenClosedEditorTab: vi.fn(() => true)
    })
    expect(store.getState().reopenClosedTab(WORKSPACE)).toBe(true)
    expect(store.getState().recentlyClosedEditorTabsByWorktree[WORKSPACE][0]).toEqual(recovered)
    store.setState({ recentlyClosedEditorTabsByWorktree: { [WORKSPACE]: [saved] } })
    expect(store.getState().reopenClosedTab(WORKSPACE)).toBe(false)
  })
})
