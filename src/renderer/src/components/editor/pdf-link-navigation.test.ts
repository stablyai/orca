import { describe, expect, it, vi } from 'vitest'
import { attachPdfLinkHistory, type PdfJsHistoryHooks } from './pdf-link-navigation'

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({ EventBus: class {}, PDFLinkService: class {} }))

type Position = { pageNumber: number; top: number; left: number }

const top = { pageNumber: 1, top: 792, left: 0 }
const section = { pageNumber: 5, top: 792, left: 0 }

/** A reader driven the way pdf.js drives its history hook: hook first, then the scroll in the same task. */
function createReader(start: Position) {
  let position = start
  let hooks: PdfJsHistoryHooks | null = null
  let recordViewArea: (location: unknown) => void = () => {}
  const attached = attachPdfLinkHistory({
    viewer: {
      pagesCount: 10,
      update: () => recordViewArea(position),
      scrollPageIntoView: ({ pageNumber, destArray }) => {
        position = { pageNumber, left: Number(destArray?.[2]), top: Number(destArray?.[3]) }
      }
    },
    linkService: {
      setHistory: (installed) => {
        hooks = installed
      },
      recordIfMoved: (move) => move()
    },
    cancelPendingLinkTargetFocus: () => {},
    isActive: () => true,
    onReaderMoved: () => {}
  })
  recordViewArea = attached.recordViewArea
  return {
    history: attached.linkHistory,
    async followLink(target: Position): Promise<void> {
      hooks?.pushCurrentPosition()
      position = target
      await Promise.resolve()
    }
  }
}

describe('attachPdfLinkHistory', () => {
  it('records a link only once pdf.js has scrolled away, so a self-link keeps Forward', async () => {
    const reader = createReader(top)
    await reader.followLink(section)
    expect(reader.history.getState()).toEqual({ canGoBack: true, canGoForward: false })

    reader.history.navigate('back')
    expect(reader.history.getState()).toEqual({ canGoBack: false, canGoForward: true })

    await reader.followLink(top)
    expect(reader.history.getState()).toEqual({ canGoBack: false, canGoForward: true })
  })
})
