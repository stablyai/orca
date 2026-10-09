import type { OpenFile } from '@/store/slices/editor'
import { beforeEach, describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { floatingWorkspaceId } from '../../../shared/floating-workspace-id'
import { projectFloatingSessionSnapshot } from './floating-session-snapshot'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  LEAF_ID
} from './web-session-tabs-sync-test-harness'
import { makeTab } from '@/store/slices/store-test-helpers'

describe('floating host session mirror', () => {
  beforeEach(resetWebSessionTabsSyncTestState)
  it('retains local tabs and main selection while projecting remote terminal layout and ownership', () => {
    const localTab = makeTab({ id: 'local-shell', worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    const state = makeState({ tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [localTab] } })
    const snapshot = projectFloatingSessionSnapshot(
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-tab::${LEAF_ID}`,
            parentTabId: 'host-tab',
            leafId: LEAF_ID,
            title: 'Remote shell',
            isActive: true,
            status: 'ready',
            terminal: 'term-host'
          }
        ],
        { worktree: FLOATING_TERMINAL_WORKTREE_ID }
      ),
      'host-one'
    )
    const next = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, 'host-one') }
    const remote = next.tabsByWorktree[floatingWorkspaceId('host-one')]
    expect(next.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([localTab])
    expect(next.activeWorktreeId).toBe(state.activeWorktreeId)
    expect(remote).toHaveLength(1)
    expect(remote[0]?.ptyId).toBe('remote:host-one@@term-host')
    expect(next.layoutByWorktree[floatingWorkspaceId('host-one')]).toBeDefined()
    expect(next.terminalLayoutsByTabId[remote[0]!.id]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      'remote:host-one@@term-host'
    )
  })
  it('isolates same-path editor files and drafts across Local and two floating hosts', () => {
    const filePath = '/home/demo/notes.md'
    const localFile: OpenFile = {
      id: filePath,
      filePath,
      relativePath: 'notes.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit',
      isDirty: true
    }
    let state = makeState({ openFiles: [localFile], editorDrafts: { [filePath]: 'local draft' } })
    for (const host of ['host-a', 'host-b']) {
      const snapshot = projectFloatingSessionSnapshot(
        makeSnapshot(
          [
            {
              type: 'markdown',
              id: `${host}-edit`,
              title: 'notes.md',
              filePath,
              relativePath: 'notes.md',
              language: 'markdown',
              mode: 'edit',
              isDirty: false,
              isActive: true,
              sourceFileId: filePath,
              sourceFilePath: filePath,
              sourceRelativePath: 'notes.md',
              documentVersion: 'v1'
            },
            {
              type: 'markdown',
              id: `${host}-preview`,
              title: 'notes.md',
              filePath,
              relativePath: 'notes.md',
              language: 'markdown',
              mode: 'markdown-preview',
              isDirty: false,
              isActive: false,
              sourceFileId: filePath,
              sourceFilePath: filePath,
              sourceRelativePath: 'notes.md',
              documentVersion: 'v1'
            }
          ],
          { worktree: FLOATING_TERMINAL_WORKTREE_ID }
        ),
        host
      )
      state = { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, host) }
      const edit = state.openFiles.find(
        (f) => f.worktreeId === floatingWorkspaceId(host) && f.mode === 'edit'
      )
      const preview = state.openFiles.find(
        (f) => f.worktreeId === floatingWorkspaceId(host) && f.mode === 'markdown-preview'
      )
      expect(edit).toBeDefined()
      expect(edit?.id).not.toBe(filePath)
      expect(edit?.isDirty).toBe(false)
      expect(preview?.markdownPreviewSourceFileId).toBe(edit?.id)
      expect(state.editorDrafts?.[edit!.id]).toBeUndefined()
    }
    expect(new Set(state.openFiles.map((f) => f.id)).size).toBe(5)
    expect(state.openFiles.find((f) => f.id === filePath)).toEqual(localFile)
    expect(state.editorDrafts?.[filePath]).toBe('local draft')
  })
})
