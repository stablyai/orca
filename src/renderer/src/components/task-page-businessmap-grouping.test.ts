import { describe, expect, it } from 'vitest'
import { groupBusinessmapCardsByColumn } from './task-page-businessmap-card-list'
import { sortBusinessmapCards } from './task-page-businessmap-card-sort'
import type { BusinessmapCard } from '../../../shared/businessmap-types'

function businessmapCard(
  id: number,
  title: string,
  columnName: string,
  columnId = 1
): BusinessmapCard {
  return {
    id,
    boardId: 7,
    title,
    url: `https://acme.businessmap.io/cards/${id}`,
    column: { id: columnId, name: columnName },
    workflowId: 1,
    labels: [],
    updatedAt: `2026-01-0${id}T00:00:00.000Z`
  }
}

describe('Businessmap card grouping', () => {
  it('groups cards by column and preserves row order', () => {
    const first = businessmapCard(1, 'First', 'To Do')
    const second = businessmapCard(2, 'Second', 'In Progress', 2)
    const third = businessmapCard(3, 'Third', 'To Do')

    const sections = groupBusinessmapCardsByColumn([first, second, third])

    expect(sections.map((section) => section.label)).toEqual(['In Progress', 'To Do'])
    expect(sections[1]?.cards).toEqual([first, third])
  })

  it('keeps the sorted card order inside the column groups', () => {
    const sorted = sortBusinessmapCards(
      [businessmapCard(2, 'Beta', 'To Do'), businessmapCard(1, 'Alpha', 'To Do')],
      'title',
      'asc'
    )
    const sections = groupBusinessmapCardsByColumn(sorted)

    expect(sections[0]?.cards.map((card) => card.id)).toEqual([1, 2])
  })
})

describe('Businessmap card selection', () => {
  it('matches the selected card by id', () => {
    const selected = businessmapCard(42, 'Selected', 'To Do')
    const sections = groupBusinessmapCardsByColumn([
      selected,
      businessmapCard(43, 'Other', 'To Do')
    ])

    expect(sections[0]?.cards.some((card) => card.id === selected.id)).toBe(true)
  })
})
