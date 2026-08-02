import { describe, expect, it } from 'vitest'

import { orderLinearStatusSections } from './linear-issue-grouping'

type StateType = 'backlog' | 'started' | 'completed' | 'canceled' | string

type TestSection = {
  key: string
  label: string
  issues: { state: { type: StateType } }[]
}

function statusSection(name: string, type: StateType): TestSection {
  return { key: `status:${name}`, label: name, issues: [{ state: { type } }] }
}

describe('orderLinearStatusSections', () => {
  it('orders status sections backlog -> started -> completed -> canceled', () => {
    const sections = [
      statusSection('In Progress', 'started'),
      statusSection('Done', 'completed'),
      statusSection('Backlog', 'backlog'),
      statusSection('Canceled', 'canceled')
    ]

    expect(orderLinearStatusSections(sections).map((s) => s.label)).toEqual([
      'Backlog',
      'In Progress',
      'Done',
      'Canceled'
    ])
  })

  it('fixes the board regression where Done appeared before Backlog', () => {
    // Reproduces the bug: Done surfaced first because its issues were updated more recently.
    const sections = [statusSection('Done', 'completed'), statusSection('Backlog', 'backlog')]

    expect(orderLinearStatusSections(sections).map((s) => s.label)).toEqual(['Backlog', 'Done'])
  })

  it('tie-breaks sections of the same type alphabetically by label', () => {
    const sections = [statusSection('In Review', 'started'), statusSection('In Progress', 'started')]

    expect(orderLinearStatusSections(sections).map((s) => s.label)).toEqual([
      'In Progress',
      'In Review'
    ])
  })

  it('sorts unknown state types after known workflow types', () => {
    const sections = [
      statusSection('Triage', 'triage'),
      statusSection('Done', 'completed'),
      statusSection('Backlog', 'backlog')
    ]

    expect(orderLinearStatusSections(sections).map((s) => s.label)).toEqual([
      'Backlog',
      'Done',
      'Triage'
    ])
  })

  it('returns a new array and does not mutate the input', () => {
    const sections = [statusSection('Done', 'completed'), statusSection('Backlog', 'backlog')]
    const original = [...sections]

    const result = orderLinearStatusSections(sections)

    expect(sections).toEqual(original)
    expect(result).not.toBe(sections)
  })

  it('handles an empty list', () => {
    expect(orderLinearStatusSections([])).toEqual([])
  })
})
