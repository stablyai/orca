// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const loading = vi.hoisted(() => {
  let release = (): void => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { entered: vi.fn(), held, release: () => release() }
})
vi.mock('./chat-markdown-math-typeset', async (original) => {
  loading.entered()
  await loading.held
  return original()
})
vi.mock('./CommentMermaidBlock', () => ({ default: () => null }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => `Translated ${fallback}`
}))
afterEach(cleanup)

it('loads only opted-in parsed math, keeping source until the shared import resolves', async () => {
  const view = render(<CommentMarkdown content="Ordinary prose" math />)
  for (const content of [
    '`$code$` and [link $label$](https://example.com)',
    'Prices $10 and $20; 中文 $10和$20',
    String.raw`\$escaped\$ and \\(escaped\\)`,
    String.raw`p \(unfinished and $unfinished`,
    '$$unfinished\n\nmore source',
    '```math\nx^2\n'
  ]) {
    view.rerender(<CommentMarkdown content={content} math />)
  }
  const source = 'Before $x^2$ after.\n\n$$y$$'
  view.rerender(<CommentMarkdown content={source} math={false} />)
  await act(async () => {})
  expect(loading.entered).not.toHaveBeenCalled()

  view.rerender(<CommentMarkdown content={source} math variant="document" />)
  await waitFor(() => expect(loading.entered).toHaveBeenCalledTimes(1))
  expect(view.container.querySelector('.katex')).toBeNull()
  expect(view.container.textContent).toContain('Before $x^2$ after.')
  expect(view.container.textContent).toContain('$$y$$')
  expect(view.container.querySelector('[role="status"],[role="progressbar"]')).toBeNull()

  await act(async () => {
    loading.release()
  })
  await waitFor(() => expect(view.container.querySelectorAll('.katex')).toHaveLength(2))
  expect(
    Array.from(view.container.querySelectorAll('annotation'), (node) => node.textContent)
  ).toEqual(['x^2', 'y'])
  expect(view.getByRole('group', { name: 'Translated Scroll display equation' }).tabIndex).toBe(0)
  expect(loading.entered).toHaveBeenCalledTimes(1)
  view.rerender(<CommentMarkdown content="Replacement prose" math />)
  expect(view.container.textContent).toBe('Replacement prose')
  expect(view.container.querySelector('.katex')).toBeNull()
})
