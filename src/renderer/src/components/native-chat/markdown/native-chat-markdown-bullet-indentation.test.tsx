// @vitest-environment happy-dom
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatMarkdown } from './NativeChatMarkdown'

afterEach(cleanup)

it('preserves literal bullet indentation with inline formatting while leaving fenced code intact', () => {
  const { container } = render(
    <NativeChatMarkdown
      variant="document"
      preserveBulletIndentation
      content={
        '• Parent\n    • **Child**\n        • [Grandchild](https://example.com)\n\n```text\n    • literal code\n```'
      }
    />
  )
  expect(container.querySelector('p')?.textContent).toBe(
    '• Parent\n    • Child\n        • Grandchild'
  )
  expect(container.querySelector('strong')?.textContent).toBe('Child')
  expect(within(container).getByRole('link', { name: 'Grandchild' }).getAttribute('href')).toBe(
    'https://example.com'
  )
  expect(container.querySelector('pre code')?.textContent).toBe('    • literal code\n')
})
