// @vitest-environment happy-dom
import { act } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  source,
  table,
  renderMarkdown,
  resolveSource,
  cancel
} from './native-markdown-render-test-fixture'
import { NativeMarkdownFence } from './NativeMarkdownFence'
import {
  NativeMarkdownRenderContext,
  type NativeMarkdownRenderContextValue
} from './native-markdown-render-context'

function Fence({
  context,
  code = 'TABLE title'
}: {
  context: NativeMarkdownRenderContextValue
  code?: string
}) {
  return (
    <NativeMarkdownRenderContext.Provider value={context}>
      <NativeMarkdownFence language="query" code={code}>
        {code}
      </NativeMarkdownFence>
    </NativeMarkdownRenderContext.Provider>
  )
}

describe('native Markdown provider lifecycle', () => {
  it('keeps one request in flight and cancels the exact session on unmount', async () => {
    vi.useFakeTimers()
    let finish: ((value: unknown) => void) | undefined
    renderMarkdown.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<Fence context={{ source, openReference: vi.fn() }} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(renderMarkdown).toHaveBeenCalledOnce()
    const sessionId = renderMarkdown.mock.calls[0]?.[0].sessionId
    view.unmount()
    expect(cancel).toHaveBeenCalledWith({ sessionId })
    await act(async () => {
      finish?.({
        status: 'rendered',
        pluginKey: 'example.query',
        sessionId,
        revision: 'late',
        output: table
      })
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(renderMarkdown).toHaveBeenCalledOnce()
  })

  it('fences changed navigation ownership even when source text and file identity match', async () => {
    vi.useFakeTimers()
    let finish: ((value: unknown) => void) | undefined
    renderMarkdown.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(
      <Fence context={{ source, ownershipKey: 'owner-one', openReference: vi.fn() }} />
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const oldSession = renderMarkdown.mock.calls[0]?.[0].sessionId
    renderMarkdown.mockResolvedValueOnce({
      status: 'rendered',
      pluginKey: 'example.query',
      sessionId: 'invalid',
      revision: 'new',
      output: table
    })
    view.rerender(<Fence context={{ source, ownershipKey: 'owner-two', openReference: vi.fn() }} />)
    await act(async () => {
      finish?.({
        status: 'rendered',
        pluginKey: 'example.query',
        sessionId: oldSession,
        revision: 'late',
        output: table
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cancel).toHaveBeenCalledWith({ sessionId: oldSession })
    expect(view.container.querySelector('table')).toBeNull()
    expect(view.container.querySelector('pre')?.textContent).toBe('TABLE title')
  })

  it('rejects a mismatched resolved file identity', async () => {
    vi.useFakeTimers()
    resolveSource.mockImplementation(async (request) => ({
      status: 'resolved',
      source: {
        fileId: 'another-file',
        worktreeId: request.worktreeId,
        documentPath: request.documentPath,
        workspacePath: '/repo',
        runtimeId: 'local-runtime'
      }
    }))
    const view = render(<Fence context={{ source, openReference: vi.fn() }} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renderMarkdown).not.toHaveBeenCalled()
    expect(view.container.querySelector('pre')?.textContent).toBe('TABLE title')
  })

  it('bounds fence source before sending it to the host', async () => {
    vi.useFakeTimers()
    const view = render(
      <Fence context={{ source, openReference: vi.fn() }} code={'x'.repeat(65537)} />
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(resolveSource).not.toHaveBeenCalled()
    expect(renderMarkdown).not.toHaveBeenCalled()
    expect(view.container.querySelector('pre')).not.toBeNull()
  })
})
