import { expect, it } from 'vitest'
import {
  includeSelectedJiraStatuses,
  orderJiraStatusCatalog
} from './task-page-jira-status-catalog'

it('orders actual workflow statuses by category and name', () => {
  expect(
    orderJiraStatusCatalog([
      { name: 'Done', categoryKey: 'done' },
      { name: 'Ready', categoryKey: 'indeterminate' },
      { name: 'Open', categoryKey: 'new' },
      { name: 'Blocked', categoryKey: 'indeterminate' }
    ]).map((status) => status.name)
  ).toEqual(['Open', 'Blocked', 'Ready', 'Done'])
})
it('keeps selected statuses visible even when a new scope has not loaded them', () => {
  expect(
    includeSelectedJiraStatuses([{ name: 'Open', categoryKey: 'new' }], ['Open', 'Developed'])
  ).toEqual([
    { name: 'Open', categoryKey: 'new' },
    { name: 'Developed', categoryKey: 'other' }
  ])
})
