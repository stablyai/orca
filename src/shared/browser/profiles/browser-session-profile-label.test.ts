import { describe, expect, it } from 'vitest'
import { browserSessionProfileLabel } from './browser-session-profile-label'

describe('browserSessionProfileLabel', () => {
  it('shows a renamed default profile under its own label', () => {
    expect(browserSessionProfileLabel('Work', 'default', '기본')).toBe('Work')
  })

  it('keeps translating the built-in default name and blank labels', () => {
    expect(browserSessionProfileLabel('Default', 'default', '기본')).toBe('기본')
    expect(browserSessionProfileLabel('', 'default', '기본')).toBe('기본')
    expect(browserSessionProfileLabel('Default', null, '기본')).toBe('기본')
  })

  it('keeps a custom profile named Default as typed and falls back to the id when blank', () => {
    expect(browserSessionProfileLabel('Default', 'work', '기본')).toBe('Default')
    expect(browserSessionProfileLabel('', 'work', '기본')).toBe('work')
  })
})
