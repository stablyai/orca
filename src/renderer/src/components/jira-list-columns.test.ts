// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JIRA_LIST_COLUMNS,
  defaultJiraListColumnIds,
  fallbackJiraSortColumn,
  formatJiraEstimate,
  jiraListGridStyle,
  jiraListGridTemplate,
  loadJiraListColumnIds,
  resolveJiraListColumnIds,
  saveJiraListColumnIds,
  visibleJiraListColumns
} from './jira-list-columns'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('Jira list columns', () => {
  it('defaults to the previous columns with planning fields hidden', () => {
    expect([...defaultJiraListColumnIds()]).toEqual([
      'key',
      'title',
      'status',
      'priority',
      'assignee',
      'updated'
    ])
  })
  it('drops invalid saved ids and retains the issue identity', () => {
    expect(
      [...resolveJiraListColumnIds(['sprint', 'storyPoints', 'bogus', null, {}])].sort()
    ).toEqual(['key', 'sprint', 'storyPoints', 'title'])
    expect([...resolveJiraListColumnIds('nope')]).toEqual([...defaultJiraListColumnIds()])
  })
  it('restores per-device choices and handles corrupt or unavailable storage', () => {
    saveJiraListColumnIds(new Set(['key', 'title', 'sprint']))
    expect([...loadJiraListColumnIds()].sort()).toEqual(['key', 'sprint', 'title'])
    localStorage.setItem('orca.jira.list-columns.v1', '{')
    expect(loadJiraListColumnIds()).toEqual(defaultJiraListColumnIds())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(() => saveJiraListColumnIds(new Set(['key', 'title']))).not.toThrow()
  })
  it('keeps a title floor at each panel tier when all columns are selected', () => {
    const columns = visibleJiraListColumns(new Set(JIRA_LIST_COLUMNS.map((column) => column.id)))
    for (const tier of [0, 1, 2] as const) {
      expect(jiraListGridTemplate(columns, tier)).toContain('minmax(180px,1fr)')
      expect(jiraListGridTemplate(columns, tier).endsWith('104px')).toBe(true)
    }
    const style = jiraListGridStyle(columns)
    expect(Number.parseInt(style['--jira-min-md'])).toBeGreaterThan(780)
    expect(Number.parseInt(style['--jira-min-lg'])).toBeGreaterThan(1050)
    expect(jiraListGridTemplate(columns, 0)).not.toContain('136px')
  })
  it('chooses a visible fallback when the active sort column is hidden', () => {
    expect(fallbackJiraSortColumn(defaultJiraListColumnIds())).toBe('updated')
    expect(fallbackJiraSortColumn(new Set(['key', 'title', 'sprint']))).toBe('key')
  })
  it('formats exact hours without assuming the Jira working day length', () => {
    expect(formatJiraEstimate(undefined)).toBe('–')
    expect(formatJiraEstimate(0)).toBe('0m')
    expect(formatJiraEstimate(45 * 60)).toBe('45m')
    expect(formatJiraEstimate(10 * 3600)).toBe('10h')
    expect(formatJiraEstimate(40 * 3600 + 30 * 60)).toBe('40h 30m')
  })
})
