// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
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
  it('keeps the error source visible even when the parser error message is empty', async () => {
    // oxlint-disable-next-line unicorn/error-message -- Models an upstream parser rejection with no message.
    mermaidApi.render.mockRejectedValue(new Error(''))
    const { container } = render(<MermaidBlock content="invalid" isDark={false} />)
    await waitFor(() => expect(container.querySelector('.mermaid-error')).not.toBeNull())
    expect(container.querySelector('code')?.textContent).toBe('invalid')
    expect(container.querySelector('svg')).toBeNull()
  })

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

  it.each(['success', 'error'] as const)(
    'ignores a cancelled %s while the corrected diagram is still rendering',
    async (outcome) => {
      const oldRender = Promise.withResolvers<{ svg: string }>()
      const currentRender = Promise.withResolvers<{ svg: string }>()
      mermaidApi.render
        .mockRejectedValueOnce(new Error('Initial syntax error'))
        .mockReturnValueOnce(oldRender.promise)
        .mockReturnValueOnce(currentRender.promise)

      const { container, rerender } = render(<MermaidBlock content="invalid" isDark={false} />)
      await waitFor(() => {
        expect(container.querySelector('.mermaid-error')?.textContent).toContain(
          'Initial syntax error'
        )
      })
      rerender(<MermaidBlock content="old correction" isDark={false} />)
      await waitFor(() => expect(mermaidApi.render).toHaveBeenCalledTimes(2))
      rerender(<MermaidBlock content="current correction" isDark={false} />)
      expect(mermaidApi.render).toHaveBeenCalledTimes(2)

      await act(async () => {
        if (outcome === 'success') {
          oldRender.resolve({ svg: '<svg data-source="old" />' })
        } else {
          oldRender.reject(new Error('Cancelled syntax error'))
        }
      })
      await waitFor(() => expect(mermaidApi.render).toHaveBeenCalledTimes(3))
      expect(container.querySelector('svg')).toBeNull()
      expect(container.querySelector('.mermaid-error')?.textContent).toContain(
        'Initial syntax error'
      )
      await act(async () => {
        currentRender.resolve({ svg: '<svg data-source="current" />' })
      })
      await waitFor(() => {
        expect(container.querySelector('.mermaid-error')).toBeNull()
        expect(container.querySelector('svg')?.getAttribute('data-source')).toBe('current')
      })
    }
  )

  it.each(['success', 'error'] as const)('ignores a late %s after unmount', async (outcome) => {
    const pendingRender = Promise.withResolvers<{ svg: string }>()
    mermaidApi.render.mockReturnValueOnce(pendingRender.promise)
    const { container, unmount } = render(<MermaidBlock content="pending" isDark={false} />)
    await waitFor(() => expect(mermaidApi.render).toHaveBeenCalledTimes(1))
    const renderId = mermaidApi.render.mock.calls[0]?.[0]
    const unrelatedErrorElement = document.createElement('div')
    unrelatedErrorElement.id = `d${renderId}`
    document.body.append(unrelatedErrorElement)
    try {
      unmount()
      await act(async () => {
        if (outcome === 'success') {
          pendingRender.resolve({ svg: '<svg data-source="late" />' })
        } else {
          pendingRender.reject(new Error('Late syntax error'))
        }
      })
      expect(container.innerHTML).toBe('')
      expect(unrelatedErrorElement.isConnected).toBe(true)
    } finally {
      unrelatedErrorElement.remove()
    }
  })
})
