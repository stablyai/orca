// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { usePluginMonacoThemeStore } from '@/store/plugin-monaco-theme'
import { useMonacoTheme } from './use-monaco-theme'

const defineTheme = vi.hoisted(() => vi.fn())
vi.mock('monaco-editor', () => ({ editor: { defineTheme } }))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))

afterEach(() => {
  usePluginMonacoThemeStore.setState({ theme: null })
})

it('uses the built-in theme until the plugin theme is defined, then switches to it', async () => {
  const { result, rerender } = renderHook(() => useMonacoTheme())
  expect(result.current).toBe('vs-dark')

  const data = { base: 'vs-dark' as const, inherit: true, rules: [], colors: {} }
  usePluginMonacoThemeStore.setState({ theme: { name: 'orca-plugin-test', data } })
  rerender()
  await waitFor(() => expect(result.current).toBe('orca-plugin-test'))
  expect(defineTheme).toHaveBeenCalledWith('orca-plugin-test', data)

  usePluginMonacoThemeStore.setState({ theme: null })
  rerender()
  expect(result.current).toBe('vs-dark')
})
