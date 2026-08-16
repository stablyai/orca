import { describe, expect, it, vi } from 'vitest'
import { buildNewWorkspaceShortcutModalData, openNewWorkspaceFromShortcut } from './useIpcEvents'

describe('buildNewWorkspaceShortcutModalData', () => {
  it('carries the active Linear issue into the Cmd+N composer', () => {
    const data = buildNewWorkspaceShortcutModalData({
      activeView: 'tasks',
      taskPageData: {
        openLinearIssue: {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix Linear context handoff',
          description: 'Pass the active issue into the agent prompt.',
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

    expect(data.telemetrySource).toBe('shortcut')
    expect(data.prefilledName).toBe('eng-123-fix-linear-context-handoff')
    expect(data.linkedWorkItem).toMatchObject({
      type: 'issue',
      number: 0,
      title: 'Fix Linear context handoff',
      url: 'https://linear.app/acme/issue/ENG-123/fix-linear-context-handoff',
      linearIdentifier: 'ENG-123'
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

describe('openNewWorkspaceFromShortcut', () => {
  it('opens the composer even when no project has been added yet', () => {
    const openModal = vi.fn()

    openNewWorkspaceFromShortcut({
      activeModal: 'none',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    } as never)

    expect(openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'shortcut'
    })
  })

  it('does not reopen the composer when it is already active', () => {
    const openModal = vi.fn()

    openNewWorkspaceFromShortcut({
      activeModal: 'new-workspace-composer',
      activeView: 'terminal',
      taskPageData: {},
      openModal
    } as never)

    expect(openModal).not.toHaveBeenCalled()
  })
})
