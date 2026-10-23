// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PdfViewer from './PdfViewer'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { requestPdfZoom } from './pdf-zoom-request'
import { readPdfScalePreference } from './pdf-scale-preference-storage'

type PdfDocumentFixture = { name: string }

const viewers = vi.hoisted((): { currentScale: number; currentScaleValue: string }[] => [])

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {} }))
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '' }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { keybindings: Record<string, never> }) => unknown) =>
    selector({ keybindings: {} })
}))
vi.mock('./pdf-document-loader', () => ({
  createPdfDocumentLoader: ({ display }: { display: (doc: PdfDocumentFixture) => () => void }) => ({
    load: () => display({ name: 'report.pdf' }),
    dispose: () => {}
  })
}))
vi.mock('./pdf-viewer-session', () => ({
  createPdfViewerSession: () => {
    const viewer = { currentScale: 1, currentScaleValue: 'page-width' }
    viewers.push(viewer)
    return { viewer, eventBus: null, findController: null, dispose: () => {} }
  }
}))

afterEach(() => {
  cleanup()
  viewers.length = 0
  localStorage.clear()
})

function renderPdf(isCommandOwner: boolean): void {
  render(
    <EditorCommandOwnerContext value={isCommandOwner}>
      <PdfViewer content={btoa('%PDF')} filePath="/repo/report.pdf" preferenceKey="report" />
    </EditorCommandOwnerContext>
  )
}

describe('PdfViewer app zoom ownership', () => {
  it('zooms the PDF in the command-owning editor pane', () => {
    renderPdf(true)

    let claimed = false
    act(() => {
      claimed = requestPdfZoom('in')
    })

    expect(claimed).toBe(true)
    expect(viewers[0].currentScale).toBe(1.25)
    expect(readPdfScalePreference('report')).toBe(1.25)

    viewers[0].currentScaleValue = '1.25'
    act(() => {
      requestPdfZoom('reset')
    })
    expect(viewers[0].currentScaleValue).toBe('page-width')
    expect(readPdfScalePreference('report')).toBe('page-width')
  })

  it('leaves zoom to the focused pane when this PDF is in an unfocused split or hidden worktree', () => {
    renderPdf(false)

    expect(requestPdfZoom('in')).toBe(false)
    expect(viewers[0].currentScale).toBe(1)
  })
})
