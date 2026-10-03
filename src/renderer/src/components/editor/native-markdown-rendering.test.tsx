// @vitest-environment happy-dom
import { act } from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  Preview,
  source,
  table,
  storeState,
  renderMarkdown,
  resolveSource,
  cancel,
  unsubscribe,
  changeListeners,
  setOutput,
  setAvailable
} from './native-markdown-render-test-fixture'
describe('native Markdown provider output', () => {
  it('renders a semantic table as text and opens references with the source document owner', async () => {
    const view = render(<Preview />)
    await waitFor(() => expect(view.container.querySelector('table')).not.toBeNull())
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('pre')).toBeNull()
    expect(resolveSource).toHaveBeenCalledWith({
      fileId: source.sourceFileId,
      documentPath: source.filePath,
      worktreeId: source.sourceWorktreeId,
      runtimeEnvironmentId: null
    })
    expect(renderMarkdown.mock.calls[0]?.[0].code).toBe('TABLE title')
    fireEvent.click(view.getByRole('button', { name: '<img src=x onerror=alert(1)>' }))
    expect(storeState.activateMarkdownLink).toHaveBeenCalledWith(
      'file:///repo/notes/one.md',
      expect.objectContaining({
        sourceFilePath: source.filePath,
        worktreeId: source.sourceWorktreeId,
        runtimeEnvironmentId: null,
        sourceOwner: { kind: 'local' }
      })
    )
  })

  it.each([
    { kind: 'list', items: [{ text: 'First item' }] },
    { kind: 'error', message: 'Query failed' }
  ])('renders semantic $kind output inline', async (value) => {
    setOutput(value)
    const view = render(<Preview />)
    await waitFor(() =>
      expect(view.container.querySelector('[data-native-markdown-output]')).not.toBeNull()
    )
    expect(view.container.textContent).toContain(
      value.kind === 'list' ? 'First item' : 'Query failed'
    )
  })

  it.each([
    { kind: 'html', html: '<script>alert(1)</script>' },
    { kind: 'table', columns: ['one'], rows: [[{ text: 'one' }, { text: 'two' }]] },
    {
      kind: 'list',
      items: [{ text: 'bad', reference: { path: '../secret.md', base: 'document' } }]
    }
  ])('falls back to source for malformed output %#', async (value) => {
    setOutput(value)
    const view = render(<Preview />)
    await waitFor(() => expect(renderMarkdown).toHaveBeenCalledOnce())
    expect(view.container.querySelector('[data-native-markdown-output]')).toBeNull()
    expect(view.container.querySelector('pre')?.textContent).toContain('TABLE title')
  })

  it('discards stale response identities', async () => {
    renderMarkdown.mockImplementation(async () => ({
      status: 'rendered',
      pluginKey: 'example.query',
      sessionId: 'old-session',
      revision: 'old',
      output: table
    }))
    const view = render(<Preview />)
    await waitFor(() => expect(renderMarkdown).toHaveBeenCalledOnce())
    expect(view.container.querySelector('table')).toBeNull()
  })

  it('clears output when disabled and cancels the previous session', async () => {
    const view = render(<Preview />)
    await waitFor(() => expect(view.container.querySelector('table')).not.toBeNull())
    setAvailable(false)
    act(() => changeListeners.forEach((listener) => listener()))
    expect(view.container.querySelector('table')).toBeNull()
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(view.container.querySelector('pre')).not.toBeNull()
  })

  it('fences an in-flight source edit and document identity change', async () => {
    let finish: ((result: unknown) => void) | undefined
    renderMarkdown.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<Preview />)
    await waitFor(() => expect(renderMarkdown).toHaveBeenCalledOnce())
    view.rerender(
      <Preview code="LIST title" fileId="replacement-file" runtimeId="remote-environment" />
    )
    await act(async () => {
      finish?.({
        status: 'rendered',
        pluginKey: 'example.query',
        sessionId: renderMarkdown.mock.calls[0]?.[0].sessionId,
        revision: 'stale',
        output: table
      })
    })
    await waitFor(() =>
      expect(resolveSource).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'replacement-file',
          runtimeEnvironmentId: 'remote-environment'
        })
      )
    )
    expect(cancel).toHaveBeenCalled()
    expect(view.container.querySelector('pre')?.textContent).toContain('LIST title')
    expect(renderMarkdown).toHaveBeenCalledOnce()
    expect(view.container.querySelector('table')).toBeNull()
  })

  it('refreshes sequentially with a known revision and stops on unmount', async () => {
    vi.useFakeTimers()
    const view = render(<Preview />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renderMarkdown).toHaveBeenCalledOnce()
    setOutput({ kind: 'list', items: [{ text: 'Changed after watch' }] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(renderMarkdown).toHaveBeenCalledTimes(2)
    expect(renderMarkdown.mock.calls[1]?.[0].knownRevision).toBe('revision-1')
    expect(view.container.querySelector('li')?.textContent).toBe('Changed after watch')
    view.unmount()
    await vi.advanceTimersByTimeAsync(10000)
    expect(renderMarkdown).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('ignores late results after unmount', async () => {
    let finish: ((result: unknown) => void) | undefined
    renderMarkdown.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<Preview />)
    await waitFor(() => expect(renderMarkdown).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => {
      finish?.({
        status: 'rendered',
        pluginKey: 'example.query',
        sessionId: renderMarkdown.mock.calls[0]?.[0].sessionId,
        revision: 'late',
        output: table
      })
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(changeListeners.size).toBe(0)
  })

  it('uses host canonical paths for source aliases and output references', async () => {
    resolveSource.mockImplementation(async (request) => ({
      status: 'resolved',
      source: {
        fileId: request.fileId,
        worktreeId: request.worktreeId,
        documentPath: '/canonical/docs/source.md',
        workspacePath: '/canonical',
        runtimeId: 'local-runtime'
      }
    }))
    const view = render(<Preview />)
    await waitFor(() => expect(view.container.querySelector('table')).not.toBeNull())
    expect(renderMarkdown.mock.calls[0]?.[0].source.documentPath).toBe('/canonical/docs/source.md')
    fireEvent.click(view.getByRole('button', { name: '<img src=x onerror=alert(1)>' }))
    expect(storeState.activateMarkdownLink).toHaveBeenCalledWith(
      'file:///canonical/notes/one.md',
      expect.objectContaining({
        sourceFilePath: '/canonical/docs/source.md',
        worktreeRoot: '/canonical'
      })
    )
  })

  it('clears failed source output and recovers sequentially from transient failures', async () => {
    vi.useFakeTimers()
    const view = render(<Preview />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(view.container.querySelector('table')).not.toBeNull()
    resolveSource.mockResolvedValueOnce({ status: 'unavailable', reason: 'unsupported-context' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(view.container.querySelector('table')).toBeNull()
    expect(view.container.querySelector('pre')).not.toBeNull()
    renderMarkdown.mockResolvedValueOnce({
      status: 'error',
      code: 'provider-error',
      message: 'Worker busy'
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(view.getByRole('alert').textContent).toBe('Worker busy')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(view.container.querySelector('table')).not.toBeNull()
  })

  it('recovers provider concurrency limits across more than four cold blocks', async () => {
    vi.useFakeTimers()
    let requests = 0
    renderMarkdown.mockImplementation(async (request) =>
      ++requests <= 4
        ? { status: 'error', code: 'provider-error', message: 'Worker busy' }
        : {
            status: 'rendered',
            pluginKey: 'example.query',
            sessionId: request.sessionId,
            revision: 'recovered',
            output: { kind: 'text', text: 'Ready' }
          }
    )
    const view = render(
      <>
        {Array.from({ length: 6 }, (_, index) => (
          <Preview key={index} fileId={`file-${index}`} />
        ))}
      </>
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renderMarkdown).toHaveBeenCalledTimes(6)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    expect(view.container.querySelectorAll('[data-native-markdown-output]')).toHaveLength(6)
    expect(view.container.querySelectorAll('pre')).toHaveLength(0)
  })

  it('does not substitute a path-matched workspace for an explicit source workspace', async () => {
    vi.useFakeTimers()
    storeState.worktreesByRepo = {
      repo: [{ id: 'different-workspace', path: '/repo', diffComments: [] }]
    }
    const view = render(<Preview workspaceId="missing-workspace" />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(resolveSource).not.toHaveBeenCalled()
    expect(renderMarkdown).not.toHaveBeenCalled()
    expect(view.container.querySelector('pre')?.textContent).toContain('TABLE title')
  })

  it('shows provider errors while retaining plain source', async () => {
    renderMarkdown.mockImplementation(async () => ({
      status: 'error',
      code: 'provider-error',
      message: 'Worker failed'
    }))
    const view = render(<Preview />)
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Worker failed'))
    expect(view.container.querySelector('pre')?.textContent).toContain('TABLE title')
  })
})
