// @vitest-environment happy-dom

import { createElement } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  getActiveMarkdownExportPayload,
  type MarkdownExportPayload
} from './markdown-export-extract'
import MermaidBlock from './MermaidBlock'
import { registerMarkdownExportRevision } from './markdown-export-revision'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, content: string) => Promise<{ svg: string }>>()
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

describe('getActiveMarkdownExportPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      })
    )
    vi.mocked(useAppStore.getState).mockReturnValue({
      openFiles: [
        {
          id: '/repo/docs/readme.md',
          filePath: '/repo/docs/readme.md',
          relativePath: 'docs/readme.md',
          mode: 'edit'
        }
      ]
    } as never)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('waits for offscreen diagrams before taking the PDF snapshot', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    const { container } = render(
      createElement(
        'div',
        { className: 'markdown-body' },
        createElement(MermaidBlock, {
          content: 'flowchart TD\n A[Hidden] --> B[Diagram]',
          isDark: false,
          lazy: true
        })
      )
    )
    expect(container.querySelector('svg')).toBeNull()
    let exporting = Promise.resolve<MarkdownExportPayload | null>(null)
    act(() => {
      exporting = getActiveMarkdownExportPayload({
        fileId: '/repo/docs/readme.md',
        root: container
      })
    })
    let settled = false
    void exporting.then(() => {
      settled = true
    })
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    await act(async () => {
      pending.resolve({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Hidden diagram</text></svg>'
      })
    })
    const payload = await exporting
    const exported = parseExportedHtml(payload?.html)
    expect(exported.querySelector('.mermaid-block svg text')?.textContent).toBe('Hidden diagram')
    expect(exported.querySelector('pre')).toBeNull()
  })

  it('abandons an export when its document unmounts while a diagram is rendering', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    const mounted = render(
      createElement(
        'div',
        { className: 'markdown-body' },
        createElement(MermaidBlock, {
          content: 'flowchart TD\n A --> B',
          isDark: false,
          lazy: true
        })
      )
    )
    let exporting = Promise.resolve<MarkdownExportPayload | null>(null)
    act(() => {
      exporting = getActiveMarkdownExportPayload({
        fileId: '/repo/docs/readme.md',
        root: mounted.container
      })
    })
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    try {
      mounted.unmount()
      await expect(exporting).resolves.toBeNull()
    } finally {
      await act(async () => {
        pending.resolve({ svg: '<svg />' })
      })
    }
  })

  it.each(['edit', 'size limit', 'file close'] as const)(
    'abandons a pending export after a document %s without replacing its root',
    async (change) => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe() {}
          disconnect() {}
        }
      )
      const pending = Promise.withResolvers<{ svg: string }>()
      mermaid.render.mockReturnValueOnce(pending.promise)
      const document = (edited: boolean) =>
        createElement(
          'div',
          { className: 'markdown-body' },
          createElement('p', null, edited ? 'Changed document' : 'Original document'),
          createElement(MermaidBlock, {
            content: 'flowchart TD\n A --> B',
            isDark: false,
            lazy: true
          }),
          edited
            ? createElement(MermaidBlock, {
                content: 'flowchart TD\n C --> D',
                isDark: false,
                lazy: true
              })
            : null
        )
      const mounted = render(document(false))
      const subtree = mounted.container.firstElementChild
      if (!subtree) {
        throw new Error('Missing rendered document')
      }
      let revision = 'original'
      const unregister = registerMarkdownExportRevision(subtree, () => revision)
      try {
        let exporting = Promise.resolve<MarkdownExportPayload | null>(null)
        act(() => {
          exporting = getActiveMarkdownExportPayload({
            fileId: '/repo/docs/readme.md',
            root: mounted.container
          })
        })
        await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
        if (change === 'edit') {
          revision = 'changed'
          mounted.rerender(document(true))
        } else if (change === 'size limit') {
          subtree.setAttribute('data-markdown-preview-incomplete', 'true')
        } else {
          vi.mocked(useAppStore.getState).mockReturnValue({
            ...useAppStore.getState(),
            openFiles: []
          })
        }
        expect(mounted.container.firstElementChild).toBe(subtree)
        await act(async () => pending.resolve({ svg: '<svg><text>Original diagram</text></svg>' }))
        await expect(exporting).resolves.toBeNull()
      } finally {
        unregister()
      }
    }
  )

  it('rejects virtual, loading, and failed previews even if export eligibility is stale', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="markdown-body" data-markdown-preview-incomplete="true"><h1>Partial</h1><img src="blob:unmounted"></div>'
    const subtree = root.firstElementChild
    if (!subtree) {
      throw new Error('Missing fixture subtree')
    }
    const clone = vi.spyOn(subtree, 'cloneNode')
    expect(
      await getActiveMarkdownExportPayload({ fileId: '/repo/docs/readme.md', root })
    ).toBeNull()
    expect(clone).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('embeds blob image sources so the PDF export window can render local images', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="ProseMirror"><p><img src="blob:rich-local-image" alt="diagram"></p></div>'

    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })

    expect(fetch).toHaveBeenCalledWith('blob:rich-local-image')
    expect(payload?.html).toContain('src="data:image/png;base64,AQID"')
    expect(payload?.html).not.toContain('blob:rich-local-image')
  })

  it('fails extraction when a blob image cannot be inlined', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false
    } as Response)
    const root = document.createElement('div')
    root.innerHTML =
      '<div class="ProseMirror"><p><img src="blob:missing-local-image" alt="diagram"></p></div>'

    await expect(
      getActiveMarkdownExportPayload({
        fileId: '/repo/docs/readme.md',
        root
      })
    ).rejects.toThrow('Failed to inline image for PDF export')
  })

  it('strips preview annotation controls so Add note buttons never reach the PDF', async () => {
    await mockPreviewOpenFile()
    const root = document.createElement('div')
    // Class-only controls in multiple blocks verify scrubbing without the generic data attribute.
    root.innerHTML = `
      <div class="markdown-body">
        <div class="markdown-annotation-block" data-source-line="1" data-source-end-line="1">
          <h1>Title</h1>
          <div class="markdown-annotation-controls">
            <button type="button" class="markdown-annotation-add" aria-label="Add note"><svg></svg></button>
            <div class="markdown-annotation-composer"><textarea>draft note</textarea></div>
            <div class="markdown-annotation-note-stack"><div class="markdown-annotation-card">saved note body</div></div>
          </div>
        </div>
        <div class="markdown-annotation-block" data-source-line="2" data-source-end-line="2">
          <p>Body text</p>
          <div class="markdown-annotation-controls">
            <button type="button" class="markdown-annotation-add" aria-label="Add note"><svg></svg></button>
          </div>
        </div>
        <pre><code class="language-mermaid">graph TD;</code></pre>
      </div>`
    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })
    const exported = parseExportedHtml(payload?.html)
    expect(exported.querySelector('h1')?.textContent).toBe('Title')
    expect(exported.querySelector('p')?.textContent).toBe('Body text')
    expect(exported.querySelector('pre code')?.textContent).toContain('graph TD;')
    expect(exported.querySelector('.markdown-annotation-controls')).toBeNull()
    expect(exported.querySelector('.markdown-annotation-add')).toBeNull()
    expect(exported.querySelector('.markdown-annotation-composer')).toBeNull()
    expect(exported.querySelector('.markdown-annotation-note-stack')).toBeNull()
    expect(exported.textContent).not.toContain('draft note')
    expect(exported.textContent).not.toContain('saved note body')
    // Why: scrub runs on a clone; the live preview keeps its controls.
    expect(root.querySelector('.markdown-annotation-controls')).not.toBeNull()
  })

  it('strips list-block annotation controls while preserving list text', async () => {
    await mockPreviewOpenFile()
    const root = document.createElement('div')
    // Attribute-only controls verify scrubbing survives class renames.
    root.innerHTML = `
      <div class="markdown-body">
        <ul>
          <li>
            <div class="markdown-annotation-list-block" data-source-line="2" data-source-end-line="2">
              <span class="markdown-annotation-list-content">List item</span>
              <div class="markdown-annotation-controls-renamed" data-orca-export-hide="true">
                <button type="button" class="markdown-annotation-add" aria-label="Add note"><svg></svg></button>
              </div>
            </div>
          </li>
        </ul>
      </div>`
    const payload = await getActiveMarkdownExportPayload({
      fileId: '/repo/docs/readme.md',
      root
    })
    const exported = parseExportedHtml(payload?.html)
    expect(exported.querySelector('li')?.textContent).toContain('List item')
    expect(exported.querySelector('[data-orca-export-hide]')).toBeNull()
    expect(exported.querySelector('.markdown-annotation-add')).toBeNull()
    expect(root.querySelector('[data-orca-export-hide]')).not.toBeNull()
  })
})

async function mockPreviewOpenFile(): Promise<void> {
  const { useAppStore } = await import('@/store')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test mock provides only openFiles, the sole store slice getActiveMarkdownExportPayload reads.
  vi.mocked(useAppStore.getState).mockReturnValue({
    openFiles: [
      {
        id: '/repo/docs/readme.md',
        filePath: '/repo/docs/readme.md',
        relativePath: 'docs/readme.md',
        mode: 'markdown-preview'
      }
    ]
  } as never)
}

function parseExportedHtml(html: string | undefined): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html ?? ''
  return container
}
