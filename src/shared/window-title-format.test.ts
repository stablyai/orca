import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_TITLE_SEPARATOR,
  DEFAULT_WINDOW_TITLE_TEMPLATE,
  finalizeWindowTitle,
  formatWindowTitle,
  normalizeWindowTitleSeparator,
  normalizeWindowTitleTemplate,
  type WindowTitleTokens
} from './window-title-format'

const gitTokens: WindowTitleTokens = {
  app: 'Orca',
  project: 'orca',
  workspace: 'Window title work',
  branch: 'feat/window-title',
  tab: 'Claude Code'
}

function format(tokens: WindowTitleTokens, template = DEFAULT_WINDOW_TITLE_TEMPLATE): string {
  return formatWindowTitle({ template, separator: DEFAULT_WINDOW_TITLE_SEPARATOR, tokens })
}

describe('formatWindowTitle', () => {
  it('renders project, branch, tab and app with the default template', () => {
    expect(format(gitTokens)).toBe('orca — feat/window-title — Claude Code — Orca')
  })

  it('treats ${session} as an alias for ${tab}', () => {
    expect(format(gitTokens, '${project}${separator}${session}${separator}${app}')).toBe(
      'orca — Claude Code — Orca'
    )
  })

  it('collapses separators around empty tokens', () => {
    expect(format({ app: 'Orca', project: 'orca' })).toBe('orca — Orca')
    expect(format({ app: 'Orca' })).toBe('Orca')
  })

  it('falls back to the workspace name when a folder workspace has no branch', () => {
    expect(
      format({ app: 'Orca', project: 'Docs Group', workspace: 'my-docs', tab: 'Shell 1' })
    ).toBe('Docs Group — my-docs — Shell 1 — Orca')
  })

  it('keeps an explicit ${workspace} instead of duplicating it into the branch slot', () => {
    expect(
      format(
        { app: 'Orca', project: 'Docs Group', workspace: 'my-docs' },
        '${project}${separator}${branch}${separator}${workspace}${separator}${app}'
      )
    ).toBe('Docs Group — my-docs — Orca')
  })

  it('drops adjacent duplicate segments', () => {
    expect(format({ app: 'Orca', project: 'orca', branch: 'orca' })).toBe('orca — Orca')
  })

  it('shows only the view and app outside the workspace view', () => {
    expect(format({ ...gitTokens, view: 'Tasks' })).toBe('Tasks — Orca')
  })

  it.each([
    ['em-dash', 'orca — Orca'],
    ['hyphen', 'orca - Orca'],
    ['pipe', 'orca | Orca']
  ] as const)('supports the %s separator', (separator, expected) => {
    expect(
      formatWindowTitle({
        template: DEFAULT_WINDOW_TITLE_TEMPLATE,
        separator,
        tokens: { app: 'Orca', project: 'orca' }
      })
    ).toBe(expected)
  })

  it('strips control characters and bidi overrides from every segment', () => {
    expect(format({ app: 'Orca', project: 'or\u0007ca\n', tab: '‮evil⁦' })).toBe(
      'or ca — evil — Orca'
    )
  })

  it('clamps long segments and the whole title', () => {
    const title = format({ app: 'Orca', project: 'p'.repeat(100), tab: 't'.repeat(100) })
    expect(title).toBe(`${'p'.repeat(59)}… — ${'t'.repeat(59)}… — Orca`)
    expect(
      finalizeWindowTitle(Array.from({ length: 10 }, () => 'x'.repeat(30)).join(' ')).length
    ).toBeLessThanOrEqual(200)
  })

  it('does not split emoji graphemes when clamping', () => {
    expect(format({ app: 'Orca', tab: '👨‍👩‍👧‍👦'.repeat(61) })).toBe(`${'👨‍👩‍👧‍👦'.repeat(59)}… — Orca`)
  })
})

describe('window title setting normalizers', () => {
  it('falls back to the default template for blank or invalid values', () => {
    expect(normalizeWindowTitleTemplate('  ')).toBe(DEFAULT_WINDOW_TITLE_TEMPLATE)
    expect(normalizeWindowTitleTemplate(42)).toBe(DEFAULT_WINDOW_TITLE_TEMPLATE)
    expect(normalizeWindowTitleTemplate(' ${tab} ')).toBe('${tab}')
  })

  it('falls back to em-dash for unknown separators', () => {
    expect(normalizeWindowTitleSeparator('pipe')).toBe('pipe')
    expect(normalizeWindowTitleSeparator('toString')).toBe('em-dash')
  })
})
