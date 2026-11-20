// @vitest-environment happy-dom
import { AnnotationMode } from 'pdfjs-dist'
import type * as pdfjsLib from 'pdfjs-dist'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfViewerSession } from './pdf-viewer-session'

const constructed = vi.hoisted((): Record<string, unknown>[] => [])

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  class EventBus {
    #listeners = new Map<string, Set<(event: unknown) => void>>()
    on(name: string, listener: (event: unknown) => void): void {
      const listeners = this.#listeners.get(name) ?? new Set()
      listeners.add(listener)
      this.#listeners.set(name, listeners)
    }
    off(name: string, listener: (event: unknown) => void): void {
      this.#listeners.get(name)?.delete(listener)
    }
    dispatch(name: string, event: unknown): void {
      for (const listener of this.#listeners.get(name) ?? []) {
        listener(event)
      }
    }
  }
  class PDFLinkService {
    setViewer(): void {}
    setDocument(): void {}
  }
  class PDFFindController {
    setDocument(): void {}
  }
  class PDFViewer {
    currentScale = 1
    currentScaleValue = 'page-width'
    pagesCount = 0
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
    }
    setDocument(): void {}
    getPageView(): null {
      return null
    }
    scrollPageIntoView(): void {}
    update(): void {}
  }
  return { EventBus, PDFFindController, PDFLinkService, PDFViewer }
})

afterEach(() => {
  constructed.length = 0
})

describe('createPdfViewerSession', () => {
  it('keeps AcroForm appearances visible without editable widgets', () => {
    const container = document.createElement('div')
    const viewerDiv = document.createElement('div')
    const session = createPdfViewerSession({
      container,
      viewerDiv,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the viewer mock never reads the document.
      doc: {} as pdfjsLib.PDFDocumentProxy,
      scrollCacheKey: null,
      getScalePreference: () => 'page-width',
      scaleBounds: { min: 0.25, max: 5 },
      onScaleChanging: () => {},
      onWheelZoom: () => {}
    })
    const layer = document.createElement('div')
    layer.className = 'annotationLayer'
    layer.innerHTML =
      '<input type="password" value="secret"><input type="text" value="Ada"><select><option value="saved" selected>Saved</option><option value="other">Other</option></select><input type="checkbox" checked>'
    const page = document.createElement('a')
    page.href = '#page'
    page.textContent = 'Page'
    let followed = false
    page.onclick = () => {
      followed = true
      return false
    }
    const reset = document.createElement('a')
    reset.textContent = 'Reset'
    reset.onclick = () => {
      const select = layer.querySelector('select')
      if (select instanceof HTMLSelectElement) {
        select.value = 'other'
        select.dispatchEvent(new Event('resetform'))
      }
      return false
    }
    layer.append(page, reset)
    container.append(layer)
    try {
      expect(constructed).toHaveLength(1)
      expect(constructed[0]?.annotationMode).toBe(AnnotationMode.ENABLE_FORMS)
      session.eventBus.dispatch('annotationlayerrendered', {})
      const password = layer.querySelector('input[type="password"]')
      const text = layer.querySelector('input[type="text"]')
      const choice = layer.querySelector('select')
      const box = layer.querySelector('input[type="checkbox"]')
      expect(password).toBeInstanceOf(HTMLInputElement)
      expect(text).toBeInstanceOf(HTMLInputElement)
      expect(choice).toBeInstanceOf(HTMLSelectElement)
      expect(box).toBeInstanceOf(HTMLInputElement)
      if (
        !(password instanceof HTMLInputElement) ||
        !(text instanceof HTMLInputElement) ||
        !(choice instanceof HTMLSelectElement) ||
        !(box instanceof HTMLInputElement)
      ) {
        throw new Error('form controls were not created')
      }
      expect(password.readOnly).toBe(true)
      expect(password.type).toBe('password')
      expect(password.value).toBe('secret')
      expect(text.readOnly).toBe(true)
      expect(text.value).toBe('Ada')
      expect(choice.disabled).toBe(true)
      expect(choice.value).toBe('saved')
      expect(box.disabled).toBe(true)
      expect(box.checked).toBe(true)
      reset.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(choice.value).toBe('saved')
      page.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(followed).toBe(true)
      expect(page.getAttribute('href')).toBe('#page')
    } finally {
      session.dispose()
    }
  })
})
