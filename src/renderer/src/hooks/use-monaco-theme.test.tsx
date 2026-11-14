// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCodeEditorThemeStore } from '@/store/appearance/code-editor-theme'
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
  // Why markdown rules: Monaco's inherit reads only its stock themes, not the redefined ones.
  expect(defineTheme).toHaveBeenCalledWith(
    'orca-plugin-test',
    expect.objectContaining({
      rules: expect.arrayContaining([expect.objectContaining({ token: 'md.markup.heading' })])
    })
  )

  useCodeEditorThemeStore.setState({ monaco: null, override: null })
  rerender()
  expect(result.current).toBe('vs-dark')
})
