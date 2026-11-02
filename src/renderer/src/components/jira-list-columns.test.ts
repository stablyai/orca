// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import {
  JIRA_LIST_COLUMNS,
  defaultJiraListColumnIds,
  getJiraListColumnLabel,
  loadJiraListColumnIds,
  resolveJiraListColumnIds,
  saveJiraListColumnIds
} from './jira-list-columns'
import esCatalog from '@/i18n/locales/es.json'

const STORAGE_KEY = 'orca.jira.list-columns.v1'

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  localStorage.clear()
  await i18n.changeLanguage('en')
})

describe('Jira list column preferences', () => {
  it('keeps Type hidden in the default column selection', () => {
    expect(defaultJiraListColumnIds().has('type')).toBe(false)
    expect(JIRA_LIST_COLUMNS.find((column) => column.id === 'type')).toMatchObject({
      widths: [104, 112, 128],
      defaultVisible: false
    })
  })

  it('uses the English Type fallback when a non-English catalog has no label', async () => {
    if (!i18n.hasResourceBundle('es', 'translation')) {
      i18n.addResourceBundle('es', 'translation', esCatalog)
    }
    await i18n.changeLanguage('es')

    expect(i18n.getResource('es', 'translation', 'auto.components.TaskPage.jiraColumnType')).toBe(
      undefined
    )
    expect(getJiraListColumnLabel('type')).toBe('Type')
  })

  it('preserves existing saved columns and always includes the locked columns', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['sprint', 'updated', 'unknown']))

    expect(loadJiraListColumnIds()).toEqual(new Set(['sprint', 'updated', 'key', 'title']))
  })

  it('persists enabling and removing Type through the existing save/load functions', () => {
    const enabled = defaultJiraListColumnIds()
    enabled.add('type')
    saveJiraListColumnIds(enabled)
    expect(loadJiraListColumnIds().has('type')).toBe(true)

    enabled.delete('type')
    saveJiraListColumnIds(enabled)
    expect(loadJiraListColumnIds().has('type')).toBe(false)
  })

  it('sanitizes unknown saved IDs without enabling other optional columns', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['key', 'title', 'type', 'unknown']))

    expect(resolveJiraListColumnIds(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'))).toEqual(
      new Set(['key', 'title', 'type'])
    )
  })
})
