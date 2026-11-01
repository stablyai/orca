import { describe, expect, it, vi } from 'vitest'
import { EMPTY_CONTRIBUTION_SOURCE, describePluginContributions } from './plugin-contributions'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => options?.[name] ?? '')
}))

function editorRow(editor: { extensions: string[]; priority?: 'default' | 'option' }): {
  detail: string
  tone: string
} {
  const [row] = describePluginContributions({
    ...EMPTY_CONTRIBUTION_SOURCE,
    customEditors: [{ title: 'Vector', filenames: [], ...editor }]
  })
  return { detail: row.detail, tone: row.tone }
}

describe('custom editor rows', () => {
  it('warns when an editor opens files in place of an Orca viewer', () => {
    expect(editorRow({ extensions: ['.svg', '.vec'], priority: 'default' })).toEqual({
      detail: 'Editor · .svg, .vec · Opens .svg instead of Orca’s viewer',
      tone: 'warning'
    })
  })

  it('hedges when only a catalog summary names the editor', () => {
    expect(editorRow({ extensions: ['.png'] }).detail).toBe(
      'Editor · .png · May open .png instead of Orca’s viewer'
    )
  })

  it('stays quiet for offered-only editors and file types Orca has no viewer for', () => {
    expect(editorRow({ extensions: ['.svg'], priority: 'option' }).tone).toBe('default')
    expect(editorRow({ extensions: ['.excalidraw'], priority: 'default' }).tone).toBe('default')
  })
})
