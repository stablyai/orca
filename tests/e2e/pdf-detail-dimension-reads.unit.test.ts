// @vitest-environment happy-dom

import type { PDFPageProxy } from 'pdfjs-dist'
// The legacy entry supplies the same Node polyfills used by the PDF find tests.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFPageView, RenderingStates } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'

let loadingTask: ReturnType<typeof getDocument> | undefined
let pdfPage: PDFPageProxy
const pageViews: PDFPageView[] = []

beforeAll(async () => {
  loadingTask = getDocument({ data: new Uint8Array(createPdfFindFixture()) })
  pdfPage = await (await loadingTask.promise).getPage(1)
})

afterEach(() => {
  for (const pageView of pageViews) {
    pageView.destroy()
  }
  pageViews.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await loadingTask?.destroy()
})

it.each([1, 10])('bounds detail update dimension reads across %i eligible owners', (population) => {
  vi.stubGlobal('devicePixelRatio', 1)
  const initialArea = { minX: 400, minY: 400, maxX: 500, maxY: 500 }
  const owners = Array.from({ length: population }, (_, index) => {
    const pageView = new PDFPageView({
      id: index + 1,
      eventBus: new EventBus(),
      defaultViewport: pdfPage.getViewport({ scale: 1 }),
      maxCanvasPixels: 1_000_000,
      capCanvasAreaFactor: -1,
      enableSelectionRendering: false
    })
    pageViews.push(pageView)
    pageView.setPdfPage(pdfPage)
    pageView.update({ scale: 4 })
    pageView._ensureCanvasWrapper()
    const wrapper = pageView.div.querySelector('.canvasWrapper')
    if (!(wrapper instanceof HTMLElement)) {
      throw new Error('Missing PDF canvas wrapper')
    }
    const reads = { count: 0 }
    Object.defineProperties(wrapper, {
      clientWidth: {
        get() {
          reads.count += 1
          return 3264
        }
      },
      clientHeight: {
        get() {
          reads.count += 1
          return 4224
        }
      }
    })
    expect(wrapper.clientWidth).toBe(3264)
    expect(wrapper.clientHeight).toBe(4224)
    expect(reads.count).toBe(2)
    pageView.updateVisibleArea(initialArea)
    const detail = pageView.detailView
    expect(detail).not.toBeNull()
    // Only update admission is measured; raster completion is the workload's precondition.
    detail.renderingState = RenderingStates.FINISHED
    const reset = vi.spyOn(detail, 'reset')
    reads.count = 0
    return { pageView, detail, reset, reads, area: initialArea }
  })
  const countReads = (): number => owners.reduce((sum, owner) => sum + owner.reads.count, 0)
  const clearCounts = (): void => {
    for (const owner of owners) {
      owner.reads.count = 0
      owner.reset.mockClear()
    }
  }
  const updateAll = (): void => {
    for (const owner of owners) {
      owner.pageView.updateVisibleArea(owner.area)
    }
  }
  const expectUnchanged = (): void => {
    for (const owner of owners) {
      expect(owner.pageView.detailView).toBe(owner.detail)
      expect(owner.detail.renderingState).toBe(RenderingStates.FINISHED)
      expect(owner.reset).not.toHaveBeenCalled()
    }
  }

  updateAll()
  expect(countReads()).toBeLessThanOrEqual(2 * population)
  expectUnchanged()

  clearCounts()
  owners[0].area = { ...initialArea, minX: 480, maxX: 580 }
  updateAll()
  expect(countReads()).toBeLessThanOrEqual(2 * (population - 1) + 4)
  for (const [index, owner] of owners.entries()) {
    expect(owner.pageView.detailView).toBe(owner.detail)
    expect(owner.reset).toHaveBeenCalledTimes(index === 0 ? 1 : 0)
    expect(owner.detail.renderingState).toBe(
      index === 0 ? RenderingStates.INITIAL : RenderingStates.FINISHED
    )
  }

  owners[0].detail.renderingState = RenderingStates.FINISHED
  clearCounts()
  for (let pass = 0; pass < 10; pass += 1) {
    updateAll()
  }
  expect(countReads()).toBeLessThanOrEqual(20 * population)
  expectUnchanged()

  clearCounts()
  for (const owner of owners) {
    owner.pageView.updateVisibleArea(null)
    expect(owner.pageView.detailView).toBeNull()
    expect(owner.reset).toHaveBeenCalledTimes(1)
    owner.pageView.updateVisibleArea(null)
    expect(owner.reset).toHaveBeenCalledTimes(1)
  }
  expect(countReads()).toBe(0)
})
