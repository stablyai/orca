// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyJiraBoardColumnOrder,
  loadJiraBoardColumnOrder,
  mergeJiraBoardColumnOrder,
  moveJiraBoardColumn,
  saveJiraBoardColumnOrder
} from './task-page-jira-board-column-order'
import type { TaskPageJiraBoardSection } from './task-page-jira-board-sections'

function section(key: string): TaskPageJiraBoardSection {
  return { key, label: key, statusIds: [key], issues: [] }
}

function keysOf(sections: readonly TaskPageJiraBoardSection[]): string[] {
  return sections.map((entry) => entry.key)
}

describe('applyJiraBoardColumnOrder', () => {
  const board = [section('todo'), section('doing'), section('done')]

  it('keeps the board order when nothing is saved', () => {
    expect(keysOf(applyJiraBoardColumnOrder(board, []))).toEqual(['todo', 'doing', 'done'])
  })

  it('applies a saved order', () => {
    expect(keysOf(applyJiraBoardColumnOrder(board, ['done', 'todo', 'doing']))).toEqual([
      'done',
      'todo',
      'doing'
    ])
  })

  it('keeps a column the saved order never saw next to the neighbour it follows', () => {
    const withReview = [section('todo'), section('review'), section('doing'), section('done')]

    expect(keysOf(applyJiraBoardColumnOrder(withReview, ['done', 'doing', 'todo']))).toEqual([
      'done',
      'doing',
      'todo',
      'review'
    ])
  })

  it('leads with a new first column rather than burying it', () => {
    const withTriage = [section('triage'), section('todo'), section('done')]

    expect(keysOf(applyJiraBoardColumnOrder(withTriage, ['done', 'todo']))).toEqual([
      'triage',
      'done',
      'todo'
    ])
  })

  it('ignores a saved column that is no longer on the board', () => {
    expect(keysOf(applyJiraBoardColumnOrder(board, ['gone', 'done', 'todo', 'doing']))).toEqual([
      'done',
      'todo',
      'doing'
    ])
  })
})

describe('moveJiraBoardColumn', () => {
  const keys = ['todo', 'doing', 'done']

  it('moves a column to the right', () => {
    expect(moveJiraBoardColumn(keys, 'todo', 'done')).toEqual(['doing', 'done', 'todo'])
  })

  it('moves a column to the left', () => {
    expect(moveJiraBoardColumn(keys, 'done', 'todo')).toEqual(['done', 'todo', 'doing'])
  })

  it('leaves the order alone for an unknown or self target', () => {
    expect(moveJiraBoardColumn(keys, 'todo', 'todo')).toEqual(keys)
    expect(moveJiraBoardColumn(keys, 'todo', 'missing')).toEqual(keys)
    expect(moveJiraBoardColumn(keys, 'missing', 'todo')).toEqual(keys)
  })
})

describe('mergeJiraBoardColumnOrder', () => {
  it('returns the visible order when nothing is saved', () => {
    expect(mergeJiraBoardColumnOrder([], ['todo', 'done'])).toEqual(['todo', 'done'])
  })

  it('keeps a lane the current filter hides behind the lane it followed', () => {
    const saved = ['todo', 'blocked', 'doing', 'done']

    expect(mergeJiraBoardColumnOrder(saved, ['done', 'todo', 'doing'])).toEqual([
      'done',
      'todo',
      'blocked',
      'doing'
    ])
  })

  it('keeps a hidden leading lane in front', () => {
    expect(mergeJiraBoardColumnOrder(['blocked', 'todo', 'done'], ['done', 'todo'])).toEqual([
      'blocked',
      'done',
      'todo'
    ])
  })

  it('adds a lane the saved order has never seen', () => {
    expect(mergeJiraBoardColumnOrder(['todo', 'done'], ['todo', 'review', 'done'])).toEqual([
      'todo',
      'review',
      'done'
    ])
  })
})

describe('Jira board column order storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns an empty order for an unseen board', () => {
    expect(loadJiraBoardColumnOrder('scope-a')).toEqual([])
  })

  it('keeps each board scope separate', () => {
    saveJiraBoardColumnOrder('scope-a', ['done', 'todo'])
    saveJiraBoardColumnOrder('scope-b', ['todo', 'done'])

    expect(loadJiraBoardColumnOrder('scope-a')).toEqual(['done', 'todo'])
    expect(loadJiraBoardColumnOrder('scope-b')).toEqual(['todo', 'done'])
  })

  it('replaces the order for a scope that is saved again', () => {
    saveJiraBoardColumnOrder('scope-a', ['done', 'todo'])
    saveJiraBoardColumnOrder('scope-a', ['todo', 'done'])

    expect(loadJiraBoardColumnOrder('scope-a')).toEqual(['todo', 'done'])
  })

  it('drops the least recently saved scope past the cap', () => {
    for (let index = 0; index < 21; index += 1) {
      saveJiraBoardColumnOrder(`scope-${index}`, ['todo'])
    }

    expect(loadJiraBoardColumnOrder('scope-0')).toEqual([])
    expect(loadJiraBoardColumnOrder('scope-1')).toEqual(['todo'])
    expect(loadJiraBoardColumnOrder('scope-20')).toEqual(['todo'])
  })

  it('falls back to an empty order when the stored value is unusable', () => {
    localStorage.setItem('orca.jira.board-column-order.v1', '{not json')
    expect(loadJiraBoardColumnOrder('scope-a')).toEqual([])

    localStorage.setItem('orca.jira.board-column-order.v1', '{"scope-a":{"not":"an array"}}')
    expect(loadJiraBoardColumnOrder('scope-a')).toEqual([])

    localStorage.setItem('orca.jira.board-column-order.v1', '{"scope-a":["todo",7,"done"]}')
    expect(loadJiraBoardColumnOrder('scope-a')).toEqual(['todo', 'done'])
  })
})
