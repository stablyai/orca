import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildNewWorkspaceShortcutModalData,
  openNewWorkspaceFromShortcut
} from './ipc-events/new-workspace-command'

const mocks = vi.hoisted(() => ({ startCreateFromCurrentWorkspace: vi.fn() }))
vi.mock('@/components/sidebar/folder-workspace-create', () => mocks)

beforeEach(() => mocks.startCreateFromCurrentWorkspace.mockReset())

describe('buildNewWorkspaceShortcutModalData', () => {
  it('uses the current folder for an ordinary global create shortcut', () => {
    const openModal = vi.fn()
    mocks.startCreateFromCurrentWorkspace.mockReturnValue({ kind: 'started' })
    openNewWorkspaceFromShortcut({
      activeModal: 'none',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    })

    expect(mocks.startCreateFromCurrentWorkspace).toHaveBeenCalledTimes(1)
    expect(openModal).not.toHaveBeenCalled()
  })

  it('seeds the composer with the current git worktree repo', () => {
    const openModal = vi.fn()
    mocks.startCreateFromCurrentWorkspace.mockReturnValue({
      kind: 'composer',
      initialRepoId: 'last-opened-repo'
    })
    openNewWorkspaceFromShortcut({
      activeModal: 'none',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    })

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'shortcut',
      initialRepoId: 'last-opened-repo'
    })
  })

  it('carries the current worktree host into the shortcut composer', () => {
    const openModal = vi.fn()
    const initialWorkspaceTarget = { projectId: 'repo:twin', hostId: 'ssh:box' }
    mocks.startCreateFromCurrentWorkspace.mockReturnValue({
      kind: 'composer',
      initialRepoId: 'twin',
      initialWorkspaceTarget
    })
    openNewWorkspaceFromShortcut({
      activeModal: 'none',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    })

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'shortcut',
      initialRepoId: 'twin',
      initialWorkspaceTarget
    })
  })

  it('keeps the task-page shortcut on the composer path', () => {
    const openModal = vi.fn()
    mocks.startCreateFromCurrentWorkspace.mockReturnValue({ kind: 'started' })
    openNewWorkspaceFromShortcut({
      activeModal: 'none',
      activeView: 'tasks',
      taskPageData: {},
      openModal
    })

    expect(mocks.startCreateFromCurrentWorkspace).not.toHaveBeenCalled()
    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'shortcut'
    })
  })

  it('does not reuse stale task context outside the Tasks view', () => {
    const data = buildNewWorkspaceShortcutModalData({
      activeView: 'terminal',
      taskPageData: {
        openLinearIssue: {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix Linear context handoff',
          url: 'https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff',
          state: { name: 'Todo', type: 'unstarted', color: '#999999' },
          team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
          labels: [],
          labelIds: [],
          priority: 3,
          estimate: null,
          updatedAt: '2026-05-29T12:00:00.000Z'
        }
      }
    } as never)

    expect(data).toEqual({ telemetrySource: 'shortcut' })
  })
})
