// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

let mockSettings: Partial<GlobalSettings> = {
  theme: 'system',
  editorThemeDark: 'dracula',
  editorThemeLight: 'one-light'
}
let mockIsDark = true

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: Partial<GlobalSettings> }) => unknown) =>
    selector({ settings: mockSettings })
}))

vi.mock('./use-document-dark-theme', () => ({
  useDocumentDarkTheme: () => mockIsDark
}))

import { useEditorTheme } from './use-editor-theme'

describe('useEditorTheme', () => {
  beforeEach(() => {
    mockSettings = {
      theme: 'system',
      editorThemeDark: 'dracula',
      editorThemeLight: 'one-light'
    }
    mockIsDark = true
  })

  it('returns configured dark theme when document theme is dark', () => {
    mockIsDark = true
    const { result } = renderHook(() => useEditorTheme())
    expect(result.current).toBe('dracula')
  })

  it('returns configured light theme when document theme is light', () => {
    mockIsDark = false
    const { result } = renderHook(() => useEditorTheme())
    expect(result.current).toBe('one-light')
  })

  it('falls back to default themes when configured themes are not set', () => {
    mockSettings = {}
    mockIsDark = true
    const { result: darkResult } = renderHook(() => useEditorTheme())
    expect(darkResult.current).toBe('vs-dark')

    mockIsDark = false
    const { result: lightResult } = renderHook(() => useEditorTheme())
    expect(lightResult.current).toBe('vs')
  })
})
