// @vitest-environment happy-dom
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatMarkdown } from './NativeChatMarkdown'

afterEach(cleanup)

it('preserves child indentation relative to Markdown list containers', () => {
  const { container } = render(
    <NativeChatMarkdown
      variant="document"
      preserveBulletIndentation
      content={
        '- Parent\n    • Child\n\n        • **Grandchild**\n\n10. Ordered parent\n      • Ordered child'
      }
    />
  )
  expect([...container.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
    'Parent\n  • Child',
    '      • Grandchild'
  ])
  expect(container.querySelector('ol li')?.textContent).toBe('Ordered parent\n  • Ordered child')
  expect(container.querySelector('strong')?.textContent).toBe('Grandchild')
  expect(container.querySelector('pre')).toBeNull()
})

it('anchors indentation to authored lines across character references and inline formatting', () => {
  const { container } = render(
    <NativeChatMarkdown
      variant="document"
      preserveBulletIndentation
      content={
        '• Parent &#10; suffix\r\n    • Child\r\n\r\n• Parent &NewLine; suffix\r\n    • Child\r\n\r\n• Parent \\&#10; suffix\r\n    • Child\r\n\r\n• Parent\r\n    • **Bold**• inline\r\n        • Grandchild'
      }
    />
  )
  expect([...container.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
    '• Parent \nsuffix\n    • Child',
    '• Parent \nsuffix\n    • Child',
    '• Parent &#10; suffix\n    • Child',
    '• Parent\n    • Bold• inline\n        • Grandchild'
  ])
})

it('keeps separated literal bullet items out of code blocks without reclassifying code samples', () => {
  const { container } = render(
    <NativeChatMarkdown
      variant="document"
      preserveBulletIndentation
      content={
        '• Parent\n  details\n\n    • **Child**\n\n        • [Grandchild][child]\n\nCode sample:\n\n    • literal code\n\n• Another parent\n\n```text\n    • fenced code\n```\n\n• Code example\n\n    const value = 1\n\n> [child]: https://example.com'
      }
    />
  )
  expect([...container.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
    '• Parent\ndetails',
    '    • Child',
    '        • Grandchild',
    'Code sample:',
    '• Another parent',
    '• Code example'
  ])
  expect(container.querySelector('strong')?.textContent).toBe('Child')
  expect(within(container).getByRole('link', { name: 'Grandchild' }).getAttribute('href')).toBe(
    'https://example.com'
  )
  expect([...container.querySelectorAll('pre code')].map((code) => code.textContent)).toEqual([
    '• literal code\n',
    '    • fenced code\n',
    'const value = 1\n'
  ])
})

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
