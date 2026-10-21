// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { useAppStore } from '../store'

vi.mock('../runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))

import { useChromeAppearanceStyle } from './use-chrome-appearance-style'

const initialState = useAppStore.getState()

describe('useChromeAppearanceStyle', () => {
  beforeEach(() => {
    useAppStore.setState({ settings: getDefaultSettings('/tmp') })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('leaves chrome on stock tokens in default mode', () => {
    const { result, unmount } = renderHook(() => useChromeAppearanceStyle())
    expect(result.current).toBeUndefined()
    unmount()
  })

  it('exposes the terminal-derived tokens the right panel and tab strip paint with', () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp'),
          leftSidebarAppearanceMode: 'match-terminal',
          terminalColorOverrides: { background: '#112233', foreground: '#ddeeff' }
        }
      })
    })
    const { result, unmount } = renderHook(() => useChromeAppearanceStyle())

    expect(result.current).toMatchObject({
      '--sidebar': '#112233',
      '--background': '#112233',
      '--foreground': '#ddeeff',
      '--card': 'color-mix(in srgb, #ddeeff 4%, #112233)',
      '--border': 'color-mix(in srgb, #ddeeff 7%, #112233)'
    })
    unmount()
  })

  it('tints the tab strip surface in tinted mode', () => {
    act(() => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp'),
          leftSidebarAppearanceMode: 'tinted',
          leftSidebarTintColor: '#7c3aed',
          leftSidebarTintOpacity: 0.25
        }
      })
    })
    const { result, unmount } = renderHook(() => useChromeAppearanceStyle())

    const tinted = 'color-mix(in srgb, #7c3aed 25%, var(--background))'
    expect(result.current).toMatchObject({
      '--sidebar': tinted,
      '--card': `color-mix(in srgb, var(--foreground) 4%, ${tinted})`
    })
    unmount()
  })

  it('keeps the same style object across unrelated settings writes', () => {
    act(() => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), leftSidebarAppearanceMode: 'tinted' }
      })
    })
    const { result, unmount } = renderHook(() => useChromeAppearanceStyle())
    const first = result.current
    expect(first).toBeDefined()

    act(() => {
      const settings = useAppStore.getState().settings!
      useAppStore.setState({
        settings: { ...settings, editorAutoSave: !settings.editorAutoSave }
      })
    })

    expect(result.current).toBe(first)
    unmount()
  })
})
