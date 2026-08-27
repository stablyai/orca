import { describe, expect, it } from 'vitest'
import type { KanbanConnectionStatus, KanbanTaskDetails } from '../../../shared/kanban-types'
import {
  classifyKanbanListFailure,
  deriveKanbanTaskDetailState,
  deriveKanbanTaskListLoadState
} from './task-page/hooks/use-task-page-kanban-fetch'

const connectedStatus: KanbanConnectionStatus = {
  connected: true,
  viewer: { id: 'u1', name: 'User One', level: 'admin' }
}
const disconnectedStatus: KanbanConnectionStatus = { connected: false, reason: 'missing' }

const detailsFixture: KanbanTaskDetails = {
  id: 't1',
  title: 'Task one',
  laneId: 'lane-open',
  laneName: 'Открыто',
  due: '2026-08-28',
  urgent: false,
  repositoryUrls: ['https://example.com/org/repo'],
  taskVersion: 1,
  executors: [{ id: 'u1', name: 'User One' }],
  observers: [],
  createdBy: null,
  url: 'https://kanban.fpimi.ru/?task=t1',
  result: 'A result',
  description: 'A description',
  tags: [],
  source: null,
  comments: [],
  blockedBy: [],
  attachments: [],
  subtasks: []
}

describe('classifyKanbanListFailure', () => {
  it('classifies authentication failures as auth', () => {
    expect(
      classifyKanbanListFailure(new Error('Kanban authentication failed. Reconnect your token.'))
    ).toEqual({ kind: 'auth' })
    expect(classifyKanbanListFailure(new Error('Kanban access is forbidden.'))).toEqual({
      kind: 'auth'
    })
  })

  it('classifies network, timeout, server and invalid-response failures as network', () => {
    for (const message of [
      'Kanban is unreachable. Check your connection.',
      'The Kanban request timed out.',
      'Kanban server error.',
      'Kanban returned an invalid response.',
      'The Kanban task changed on the server. Try again.',
      'Some unexpected failure.'
    ]) {
      const result = classifyKanbanListFailure(new Error(message))
      expect(result.kind).toBe('network')
      if (result.kind === 'network') {
        expect(result.message).toBe(message)
      }
    }
  })
})

describe('deriveKanbanTaskListLoadState', () => {
  it('shows the disconnected state before any connection exists', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: disconnectedStatus,
        loading: false,
        error: null,
        visibleTaskCount: 0
      })
    ).toEqual({ kind: 'disconnected' })
  })

  it('shows the loading state during the first load', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: connectedStatus,
        loading: true,
        error: null,
        visibleTaskCount: 0
      })
    ).toEqual({ kind: 'loading' })
  })

  it('keeps a stale successful list and reports the network warning', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: connectedStatus,
        loading: false,
        error: { kind: 'network', message: 'Kanban is unreachable. Check your connection.' },
        visibleTaskCount: 3
      })
    ).toEqual({ kind: 'stale', message: 'Kanban is unreachable. Check your connection.' })
  })

  it('replaces the list with reconnect on auth failure even when data exists', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: connectedStatus,
        loading: false,
        error: { kind: 'auth' },
        visibleTaskCount: 3
      })
    ).toEqual({ kind: 'auth' })
  })

  it('shows the empty state when connected with no visible tasks', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: connectedStatus,
        loading: false,
        error: null,
        visibleTaskCount: 0
      })
    ).toEqual({ kind: 'empty' })
  })

  it('shows a network error even with no cached list', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: connectedStatus,
        loading: false,
        error: { kind: 'network', message: 'Kanban server error.' },
        visibleTaskCount: 0
      })
    ).toEqual({ kind: 'network-empty', message: 'Kanban server error.' })
  })

  it('is ready when connected with visible tasks', () => {
    expect(
      deriveKanbanTaskListLoadState({
        status: connectedStatus,
        loading: false,
        error: null,
        visibleTaskCount: 2
      })
    ).toEqual({ kind: 'ready' })
  })
})

describe('deriveKanbanTaskDetailState', () => {
  it('is idle while no task is selected', () => {
    expect(
      deriveKanbanTaskDetailState({
        selectedTaskId: null,
        detail: null,
        detailLoading: false,
        detailError: false
      })
    ).toEqual({ kind: 'idle' })
  })

  it('is loading while the selected task is being fetched', () => {
    expect(
      deriveKanbanTaskDetailState({
        selectedTaskId: 't1',
        detail: null,
        detailLoading: true,
        detailError: false
      })
    ).toEqual({ kind: 'loading' })
  })

  it('reports not-found when the detail is missing', () => {
    expect(
      deriveKanbanTaskDetailState({
        selectedTaskId: 't1',
        detail: null,
        detailLoading: false,
        detailError: false
      })
    ).toEqual({ kind: 'not-found' })
  })

  it('reports an error when the detail fetch failed', () => {
    expect(
      deriveKanbanTaskDetailState({
        selectedTaskId: 't1',
        detail: null,
        detailLoading: false,
        detailError: true
      })
    ).toEqual({ kind: 'error' })
  })

  it('is ready with the fetched detail', () => {
    expect(
      deriveKanbanTaskDetailState({
        selectedTaskId: 't1',
        detail: detailsFixture,
        detailLoading: false,
        detailError: false
      })
    ).toEqual({ kind: 'ready', detail: detailsFixture })
  })
})
