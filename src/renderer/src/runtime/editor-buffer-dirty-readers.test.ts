import type { AgentStatusReadState } from '@/store/agent-status-observers'
import { applyAgentStatusPatch } from '@/store/agent-status-patch'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'

import { buildEditorSessionData } from '../lib/workspace-session'
import { sameOpenFiles } from './web-session-tabs-sync/state-equality-files'
import { buildRuntimeMobileOpenFilesProjection } from './sync-runtime-graph/sync-projections'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { makeState } from './sync-runtime-graph-test-harness'
import type { Tab } from '../../../shared/tab-types'

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => null
}))

const FILE_ID = '/repo/README.md'

function resetEditorState(): void {
  applyAgentStatusPatch(useAppStore, { openFiles: [], editorDrafts: {} })
  const tab: Tab = {
    id: 'tab-md',
    entityId: FILE_ID,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'editor',
    label: FILE_ID,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  applyAgentStatusPatch(useAppStore, { unifiedTabsByWorktree: { 'wt-1': [tab] } })
}

function openMarkdownFile(): void {
  useAppStore.getState().openFile({
    filePath: FILE_ID,
    relativePath: 'README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
}

/** Dirties the tab through its buffer record and returns the store on either side. */
function dirtyThroughRecord(): { before: AgentStatusReadState; after: AgentStatusReadState } {
  const before = getAgentStatusOwner(useAppStore).getState()
  before.markFileDirty(FILE_ID, true)
  const after = getAgentStatusOwner(useAppStore).getState()
  expect(after.editorBuffers[FILE_ID]?.isDirty).toBe(true)
  return { before, after }
}

describe('a dirty change on the buffer record reaches every openFiles reader', () => {
  beforeEach(() => {
    resetEditorState()
    openMarkdownFile()
  })

  it('web session tab sync sees the open files change', () => {
    const { before, after } = dirtyThroughRecord()

    expect(sameOpenFiles(before.openFiles, after.openFiles)).toBe(false)
  })

  it('session save persists the draft of the now-dirty tab', () => {
    useAppStore.getState().setEditorDraft(FILE_ID, '# edited\n')
    const save = (state: AgentStatusReadState) =>
      buildEditorSessionData(
        state.openFiles,
        state.editorDrafts,
        state.markdownFrontmatterVisible,
        state.activeFileIdByWorktree,
        state.activeTabTypeByWorktree
      ).openFilesByWorktree?.['wt-1']?.[0]?.dirtyDraftContent

    const { before, after } = dirtyThroughRecord()

    expect(save(before)).toBeUndefined()
    expect(save(after)).toBe('# edited\n')
  })

  it('mobile session projections publish the dirty flag', () => {
    const { before, after } = dirtyThroughRecord()
    const markdownTab = (state: AgentStatusReadState) =>
      buildMobileSessionTabSnapshots(
        makeState({
          openFiles: state.openFiles,
          editorDrafts: state.editorDrafts,
          unifiedTabsByWorktree: state.unifiedTabsByWorktree,
          tabBarOrderByWorktree: { 'wt-1': [FILE_ID] }
        })
      )[0]?.tabs.find((tab) => tab.type === 'markdown')

    expect(buildRuntimeMobileOpenFilesProjection(after.openFiles)).not.toBe(
      buildRuntimeMobileOpenFilesProjection(before.openFiles)
    )
    expect(markdownTab(before)).toMatchObject({ isDirty: false })
    expect(markdownTab(after)).toMatchObject({ isDirty: true })
  })
})
