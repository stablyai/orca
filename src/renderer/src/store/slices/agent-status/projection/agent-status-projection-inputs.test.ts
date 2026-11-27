import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import { captureProjectionInputs } from './agent-status-projection-state'

describe('captureProjectionInputs', () => {
  it('retains only projection input slice refs and drops unrelated AppState fields', () => {
    const fakeFullState = {
      acknowledgedAgentsByPaneKey: { 't:l': 1 },
      agentSenderPublicationsByHost: {},
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      paneForegroundAgentByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      settings: {},
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      removedRuntimeEnvironmentIds: [],
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      // Unrelated heavy store fields that must NOT be pinned inside projection.data.inputs:
      agentStatusByPaneKey: { sentinel: 'heavy-status-map' },
      openFiles: [{ id: 'f1' }],
      editorDrafts: { f1: 'huge-draft' },
      browserPagesByWorkspace: { w1: [] },
      groupsByWorktree: { w1: [] },
      contestedPrimaryHostBySessionKey: { k1: 'local' },
      structuredChatSleptAtByPaneKey: { p1: 123 }
    } as unknown as AppState

    const captured = captureProjectionInputs(fakeFullState)
    expect(captured.acknowledgedAgentsByPaneKey).toBe(fakeFullState.acknowledgedAgentsByPaneKey)
    expect(captured.tabsByWorktree).toBe(fakeFullState.tabsByWorktree)
    expect(captured.unifiedTabsByWorktree).toBe(fakeFullState.unifiedTabsByWorktree)
    expect('agentStatusByPaneKey' in captured).toBe(false)
    expect('openFiles' in captured).toBe(false)
    expect('editorDrafts' in captured).toBe(false)
    expect('browserPagesByWorkspace' in captured).toBe(false)
    expect('groupsByWorktree' in captured).toBe(false)
    expect('contestedPrimaryHostBySessionKey' in captured).toBe(false)
    expect('structuredChatSleptAtByPaneKey' in captured).toBe(false)
  })
})
