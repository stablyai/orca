import { describe, expect, it } from 'vitest'
import { parseDesktopAppSelector, selectorNamesApp } from './desktop-app-selector'

describe('parseDesktopAppSelector', () => {
  it('reads pid selectors with the native grammar', () => {
    expect(parseDesktopAppSelector('pid:42')).toEqual({ kind: 'pid', pid: 42 })
    expect(parseDesktopAppSelector('\u0085pid:+042 ')).toEqual({ kind: 'pid', pid: 42 })
    expect(parseDesktopAppSelector('PID:42')).toEqual({ kind: 'name', name: 'PID:42' })
    expect(parseDesktopAppSelector('pid:0')).toEqual({ kind: 'name', name: 'pid:0' })
    expect(parseDesktopAppSelector('pid:2147483648')).toEqual({
      kind: 'name',
      name: 'pid:2147483648'
    })
  })

  it('returns null for missing or blank selectors', () => {
    expect(parseDesktopAppSelector(null)).toBeNull()
    expect(parseDesktopAppSelector(' \t')).toBeNull()
  })
})

describe('selectorNamesApp', () => {
  const app = { appName: 'Notes', bundleId: 'com.example.notes' }

  it('matches name or bundle id case-insensitively but accent-sensitively', () => {
    expect(selectorNamesApp('notes', app)).toBe(true)
    expect(selectorNamesApp('COM.EXAMPLE.NOTES', app)).toBe(true)
    expect(selectorNamesApp('pépper', app)).toBe(false)
    expect(selectorNamesApp('notes', { appName: 'Other', bundleId: null })).toBe(false)
  })
})
