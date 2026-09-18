// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaidApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn()
}))

vi.mock('mermaid', () => ({
  default: mermaidApi
}))

vi.mock('dompurify', () => ({
  default: {
    sanitize: (html: string) => html
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import MermaidBlock from './MermaidBlock'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  mermaidApi.initialize.mockReset()
  mermaidApi.render.mockReset()
})

function mockMermaidSource(content: string): Promise<{ svg: string }> {
  if (content.includes('TDD')) {
    return Promise.reject(new Error('Syntax error in text'))
  }
  return Promise.resolve({ svg: `<svg data-source="${content}"></svg>` })
}

describe('MermaidBlock', () => {
  it('shows a diagram error for invalid syntax and keeps the source visible', async () => {
    mermaidApi.render.mockImplementation((_id: string, content: string) =>
      mockMermaidSource(content)
    )

    const { container } = render(<MermaidBlock content="graph TDD; A-->B" isDark={false} />)

    await waitFor(() => {
      expect(container.querySelector('.mermaid-error')).not.toBeNull()
    })
    expect(container.textContent).toContain('Diagram error:')
    expect(container.textContent).toContain('Syntax error in text')
    expect(container.querySelector('code')?.textContent).toBe('graph TDD; A-->B')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('re-renders the diagram after a syntax error is fixed without remounting', async () => {
    mermaidApi.render.mockImplementation((_id: string, content: string) =>
      mockMermaidSource(content)
    )

    const { container, rerender } = render(
      <MermaidBlock content="graph TDD; A-->B" isDark={false} />
    )

    await waitFor(() => {
      expect(container.querySelector('.mermaid-error')).not.toBeNull()
    })

    rerender(<MermaidBlock content="graph TD; A-->B" isDark={false} />)

    await waitFor(() => {
      expect(container.querySelector('.mermaid-error')).toBeNull()
      expect(container.querySelector('svg')?.getAttribute('data-source')).toBe('graph TD; A-->B')
    })
  })

  it('shows a diagram error again if the source becomes invalid after a successful render', async () => {
    mermaidApi.render.mockImplementation((_id: string, content: string) =>
      mockMermaidSource(content)
    )

    const { container, rerender } = render(
      <MermaidBlock content="graph TD; A-->B" isDark={false} />
    )

    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull()
    })

    rerender(<MermaidBlock content="graph TDD; A-->B" isDark={false} />)

    await waitFor(() => {
      expect(container.querySelector('.mermaid-error')).not.toBeNull()
      expect(container.querySelector('svg')).toBeNull()
    })
    expect(container.querySelector('code')?.textContent).toBe('graph TDD; A-->B')
  })
})
