import { describe, expect, it } from 'vitest'
import { applyJiraBoardLaneOrder, moveJiraBoardLane } from './task-page-jira-board-lane-order'

const lanes = (...labels: string[]): { label: string }[] => labels.map((label) => ({ label }))
const labels = (items: { label: string }[]): string[] => items.map((item) => item.label)

describe('applyJiraBoardLaneOrder', () => {
  it('reorders saved lanes by name and leaves unsaved lanes in their default slots', () => {
    const ordered = applyJiraBoardLaneOrder(lanes('Done', 'Blocked', 'In Progress', 'To Do'), [
      'to do',
      'in progress',
      'done'
    ])
    expect(labels(ordered)).toEqual(['To Do', 'Blocked', 'In Progress', 'Done'])
  })
})

describe('moveJiraBoardLane', () => {
  it('keeps a lane that is hidden now next to the lane it followed', () => {
    const order = moveJiraBoardLane(['To Do', 'In Progress', 'Done'], 2, 0, [
      'to do',
      'qa fail',
      'in progress',
      'done'
    ])
    expect(order).toEqual(['done', 'to do', 'qa fail', 'in progress'])
  })

  it('matches a board column and a fallback status lane by name, ignoring case', () => {
    const order = moveJiraBoardLane(['IN PROGRESS', 'To Do'], 1, 0, [])
    expect(labels(applyJiraBoardLaneOrder(lanes('In Progress', 'To Do'), order))).toEqual([
      'To Do',
      'In Progress'
    ])
  })
})
