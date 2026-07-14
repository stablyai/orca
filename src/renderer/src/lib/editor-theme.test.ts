import { describe, expect, it } from 'vitest'
import { resolveMonacoEditorTheme } from './editor-theme'

describe('resolveMonacoEditorTheme', () => {
  it('follows the resolved app theme by default', () => {
    expect(resolveMonacoEditorTheme(undefined, false)).toBe('vs')
    expect(resolveMonacoEditorTheme('app', true)).toBe('vs-dark')
  })

  it.each([
    ['light', 'vs'],
    ['dark', 'vs-dark'],
    ['high-contrast-light', 'hc-light'],
    ['high-contrast-dark', 'hc-black'],
    ['dracula', 'orca-dracula']
  ] as const)('maps %s to %s independently of the app theme', (preference, expected) => {
    expect(resolveMonacoEditorTheme(preference, false)).toBe(expected)
    expect(resolveMonacoEditorTheme(preference, true)).toBe(expected)
  })
})
