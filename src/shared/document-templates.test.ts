import { describe, expect, it } from 'vitest'
import {
  getMarkdownTemplateVariables,
  getTitleFromMarkdownPath,
  renderMarkdownTemplate
} from './document-templates'

describe('document template helpers', () => {
  it('replaces supported placeholders', () => {
    const variables = {
      title: 'Daily Note',
      filename: 'daily-note.md',
      date: '2026-04-30',
      time: '09:05',
      datetime: '2026-04-30 09:05'
    }

    expect(
      renderMarkdownTemplate('# {{title}}\n{{filename}}\n{{date}} {{time}} {{datetime}}', variables)
    ).toBe('# Daily Note\ndaily-note.md\n2026-04-30 09:05 2026-04-30 09:05')
  })

  it('supports whitespace inside placeholders', () => {
    const variables = {
      title: 'Title',
      filename: 'file.md',
      date: '2026-04-30',
      time: '09:05',
      datetime: '2026-04-30 09:05'
    }

    expect(renderMarkdownTemplate('{{ title }} {{ filename }}', variables)).toBe('Title file.md')
  })

  it('leaves unknown placeholders unchanged', () => {
    const variables = {
      title: 'Title',
      filename: 'file.md',
      date: '2026-04-30',
      time: '09:05',
      datetime: '2026-04-30 09:05'
    }

    expect(renderMarkdownTemplate('{{unknown}} {{ title }}', variables)).toBe('{{unknown}} Title')
  })

  it('formats local date and time deterministically with an injected Date', () => {
    const variables = getMarkdownTemplateVariables({
      title: 'Title',
      filename: 'file.md',
      now: new Date(2026, 3, 30, 9, 5, 30)
    })

    expect(variables).toEqual({
      title: 'Title',
      filename: 'file.md',
      date: '2026-04-30',
      time: '09:05',
      datetime: '2026-04-30 09:05'
    })
  })

  it('derives predictable titles from filenames', () => {
    expect(getTitleFromMarkdownPath('daily-note.md')).toBe('daily-note')
    expect(getTitleFromMarkdownPath('notes/foo.bar.md')).toBe('foo.bar')
    expect(getTitleFromMarkdownPath('README.md')).toBe('README')
  })
})
