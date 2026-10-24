// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: () => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }
}))
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatMarkdown } from './NativeChatMarkdown'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(cleanup)

const ARABIC_REPLY = [
  '## مرحبا',
  '',
  'هذا ملف `index.ts` للتجربة.',
  '',
  '- العنصر الأول',
  '- Second item',
  '',
  '> اقتباس',
  '',
  '```ts',
  '// تعليق',
  'const answer = 42',
  '```'
].join('\n')

function renderReply(): void {
  render(
    <NativeChatMarkdown
      content={ARABIC_REPLY}
      variant="document"
      renderCodeBlock={NativeChatCodeBlock}
    />
  )
}

describe('NativeChatMarkdown text direction', () => {
  it('lets each prose block read in the direction most of its words do', () => {
    renderReply()
    expect(screen.getByRole('heading', { name: 'مرحبا' })).toHaveAttribute('dir', 'rtl')
    expect(screen.getByText(/للتجربة/).closest('p')).toHaveAttribute('dir', 'rtl')
  })

  it('keeps an Arabic sentence right-to-left when it opens with an English word', () => {
    render(<NativeChatMarkdown content="React هو مكتبة لبناء الواجهات." variant="document" />)
    expect(screen.getByText(/مكتبة/).closest('p')).toHaveAttribute('dir', 'rtl')
  })

  it('turns a list and a quote with their text', () => {
    renderReply()
    expect(screen.getByRole('list')).toHaveAttribute('dir', 'rtl')
    expect(screen.getByText('اقتباس').closest('blockquote')).toHaveAttribute('dir', 'rtl')
  })

  it('keeps a mostly English list left-to-right', () => {
    render(<NativeChatMarkdown content={'- First item\n- Second مرحبا'} variant="document" />)
    expect(screen.getByRole('list')).toHaveAttribute('dir', 'ltr')
  })

  it('keeps fenced code left-to-right even when it opens with Arabic', () => {
    renderReply()
    const pre = screen.getByText(/const answer/).closest('pre')
    expect(pre?.closest('[dir]')).toHaveAttribute('dir', 'ltr')
  })
})
