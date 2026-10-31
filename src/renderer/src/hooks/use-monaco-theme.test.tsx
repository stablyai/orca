// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCodeEditorThemeStore } from '@/store/code-editor-theme'
import { useMonacoTheme } from './use-monaco-theme'

const defineTheme = vi.hoisted(() => vi.fn())
vi.mock('monaco-editor', () => ({ editor: { defineTheme } }))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))

afterEach(() => {
  useCodeEditorThemeStore.setState({ monaco: null, override: null })
})

it('uses the built-in theme until the plugin theme is defined, then switches to it', async () => {
  const { result, rerender } = renderHook(() => useMonacoTheme())
  expect(result.current).toBe('vs-dark')

  const data = { base: 'vs-dark' as const, inherit: true, rules: [], colors: {} }
  useCodeEditorThemeStore.setState({ monaco: { name: 'orca-plugin-test', data } })
  rerender()
  await waitFor(() => expect(result.current).toBe('orca-plugin-test'))
  expect(defineTheme).toHaveBeenCalledWith('orca-plugin-test', data)

  useCodeEditorThemeStore.setState({ monaco: null, override: null })
  rerender()
  expect(result.current).toBe('vs-dark')
})

it('falls back to the built-in theme of an editor theme whose base differs from the app', () => {
  useCodeEditorThemeStore.setState({
    override: {
      base: 'light',
      colors: { background: '#fff', foreground: '#000', mutedForeground: '#555', border: '#ccc' }
    }
  })
  const { result } = renderHook(() => useMonacoTheme())
  expect(result.current).toBe('vs')
})
