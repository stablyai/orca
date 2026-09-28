// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

describe('getActiveMarkdownExportPayload', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      })
    )
    const { useAppStore } = await import('@/store')
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
    vi.unstubAllGlobals()
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
    // Why: class-only fixture proves the explicit selector scrubs even when
    // the data attr is absent; two blocks prove every block is scrubbed.
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
    // Why: attr-only fixture (renamed class) proves the generic
    // data-orca-export-hide rule scrubs even after a class rename.
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
