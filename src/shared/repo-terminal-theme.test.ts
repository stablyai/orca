import { describe, expect, it } from 'vitest'
import {
  isStorableRepoTerminalThemeSelection,
  MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH,
  buildRepoTerminalThemeUpdate,
  getTerminalThemeRepoId,
  normalizeRepoTerminalThemeOverrides,
  type RepoTerminalThemeOverrides
} from './repo-terminal-theme'

describe('normalizeRepoTerminalThemeOverrides', () => {
  it.each([undefined, null, 'Tango Dark', ['Tango Dark'], {}])(
    'returns undefined for %j',
    (value) => {
      expect(normalizeRepoTerminalThemeOverrides(value)).toBeUndefined()
    }
  )

  it('drops whitespace-only values and trims valid ones', () => {
    expect(normalizeRepoTerminalThemeOverrides({ dark: '  Tango Dark  ', light: '   ' })).toEqual({
      dark: 'Tango Dark'
    })
    expect(normalizeRepoTerminalThemeOverrides({ dark: '  ', light: '\t' })).toBeUndefined()
  })

  it('drops non-string values', () => {
    expect(normalizeRepoTerminalThemeOverrides({ dark: 42, light: 'One Light' })).toEqual({
      light: 'One Light'
    })
    expect(normalizeRepoTerminalThemeOverrides({ dark: { name: 'x' } })).toBeUndefined()
  })

  it('drops values over the max length', () => {
    const atMax = 'a'.repeat(MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH)
    const overMax = 'a'.repeat(MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH + 1)
    expect(normalizeRepoTerminalThemeOverrides({ dark: atMax, light: overMax })).toEqual({
      dark: atMax
    })
  })

  it('strips unknown keys', () => {
    expect(
      normalizeRepoTerminalThemeOverrides({ dark: 'Tango Dark', extra: 'nope', system: 'x' })
    ).toEqual({ dark: 'Tango Dark' })
  })

  it('keeps custom selections', () => {
    expect(normalizeRepoTerminalThemeOverrides({ light: 'custom:ghostty:my-theme' })).toEqual({
      light: 'custom:ghostty:my-theme'
    })
  })
})

describe('buildRepoTerminalThemeUpdate', () => {
  const update = (terminalTheme: RepoTerminalThemeOverrides | null) => ({
    kind: 'update',
    terminalTheme
  })

  it('sets dark on an undefined current value', () => {
    expect(buildRepoTerminalThemeUpdate(undefined, 'dark', 'Tango Dark')).toEqual(
      update({ dark: 'Tango Dark' })
    )
  })

  it('replaces the light variant and keeps dark', () => {
    expect(
      buildRepoTerminalThemeUpdate(
        { dark: 'Tango Dark', light: 'One Light' },
        'light',
        ' GitHub Light '
      )
    ).toEqual(update({ dark: 'Tango Dark', light: 'GitHub Light' }))
  })

  it('clearing one variant keeps the other', () => {
    expect(
      buildRepoTerminalThemeUpdate({ dark: 'Tango Dark', light: 'One Light' }, 'dark', null)
    ).toEqual(update({ light: 'One Light' }))
  })

  it('treats a blank selection as a clear', () => {
    expect(
      buildRepoTerminalThemeUpdate({ dark: 'Tango Dark', light: 'One Light' }, 'light', '  ')
    ).toEqual(update({ dark: 'Tango Dark' }))
  })

  it('writes the null clear sentinel when the last variant is cleared', () => {
    expect(buildRepoTerminalThemeUpdate({ dark: 'Tango Dark' }, 'dark', null)).toEqual(update(null))
    expect(buildRepoTerminalThemeUpdate(undefined, 'light', null)).toEqual(update(null))
  })

  it('keeps a long custom selection storable end to end', () => {
    const long = `custom:ghostty:${'x'.repeat(400)}`
    expect(buildRepoTerminalThemeUpdate({ light: 'One Light' }, 'dark', long)).toEqual(
      update({ light: 'One Light', dark: long })
    )
  })

  it('rejects an unstorable pick instead of writing anything', () => {
    const tooLong = 'a'.repeat(MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH + 1)
    expect(isStorableRepoTerminalThemeSelection(tooLong)).toBe(false)
    expect(buildRepoTerminalThemeUpdate({ dark: 'Dracula' }, 'dark', tooLong)).toEqual({
      kind: 'rejected'
    })
    expect(buildRepoTerminalThemeUpdate(undefined, 'dark', tooLong)).toEqual({ kind: 'rejected' })
  })

  it('does not mutate the current value', () => {
    const current = { dark: 'Tango Dark' }
    buildRepoTerminalThemeUpdate(current, 'dark', null)
    expect(current).toEqual({ dark: 'Tango Dark' })
  })
})

describe('getTerminalThemeRepoId', () => {
  it('maps a worktree to its repo and gives folder workspaces none', () => {
    expect(getTerminalThemeRepoId('repo-a::/src/app')).toBe('repo-a')
    expect(getTerminalThemeRepoId('folder:abc')).toBeNull()
    expect(getTerminalThemeRepoId(null)).toBeNull()
  })
})
