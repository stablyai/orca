import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { setSettingsActiveSection, useSettingsActiveSection } from './settings-active-section'

describe('settings active section', () => {
  it('tells the header which section is showing, and forgets it when Settings closes', () => {
    const { result } = renderHook(() => useSettingsActiveSection())
    act(() => setSettingsActiveSection('cloud-billing'))
    expect(result.current).toBe('cloud-billing')
    act(() => setSettingsActiveSection('general'))
    expect(result.current).toBe('general')
    act(() => setSettingsActiveSection(null))
    expect(result.current).toBeNull()
  })
})
