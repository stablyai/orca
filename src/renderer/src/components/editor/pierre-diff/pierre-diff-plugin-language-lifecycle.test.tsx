// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { RegisteredCustomLanguages } from '@pierre/diffs'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginSyntaxMetadata } from '../../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { usePierreDiffLanguage, usePierreRenderedLanguage } from './pierre-diff-language'

const syntaxes = vi.hoisted(() => ({ current: [] as PluginSyntaxMetadata[] }))
vi.mock('@/store/plugins/syntax/plugin-syntax-packs', () => ({
  usePluginSyntaxes: () => syntaxes.current,
  resolvePluginSyntaxForFile: (entries: PluginSyntaxMetadata[]) => entries[0] ?? null
}))
const revision = (value: string): PluginSyntaxMetadata => ({
  id: 'plugin:demo',
  pluginKey: 'demo',
  label: 'Demo',
  extensions: ['.demo'],
  filenames: [],
  revision: value
})
afterEach(cleanup)

function renderSurface() {
  return renderHook(
    ({ rendered }: { rendered?: string }) => {
      const lang = usePierreDiffLanguage('file.demo', 'plaintext')
      usePierreRenderedLanguage(rendered)
      return lang
    },
    { initialProps: {} as { rendered?: string } }
  )
}

it('keeps a plugin grammar registered while a scrolled-out row can return to it', () => {
  syntaxes.current = [revision('1')]
  const first = renderSurface()
  const name = first.result.current
  first.unmount()
  expect(RegisteredCustomLanguages.has(name)).toBe(true)
  expect(renderSurface().result.current).toBe(name)
})

it('retires a superseded grammar only after the diff rendered with it stops rendering', () => {
  syntaxes.current = [revision('2')]
  const surface = renderSurface()
  const previous = surface.result.current
  surface.rerender({ rendered: previous })
  syntaxes.current = [revision('3')]
  surface.rerender({ rendered: previous })
  const next = surface.result.current
  expect(next).not.toBe(previous)
  expect(RegisteredCustomLanguages.has(previous)).toBe(true)
  surface.rerender({ rendered: next })
  expect(RegisteredCustomLanguages.has(previous)).toBe(false)
  expect(RegisteredCustomLanguages.has(next)).toBe(true)
})
