// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  annotateEscOwner,
  annotateLetterOwner,
  registerAnnotateKeyPage,
  resolvedAnnotatePage
} from './annotate-esc-ownership'

const cleanups: (() => void)[] = []

beforeEach(() => {
  // happy-dom has no layout: every connected element counts as rendered unless marked collapsed here.
  Object.defineProperty(Element.prototype, 'checkVisibility', {
    configurable: true,
    value(this: Element): boolean {
      return !this.closest('[data-test-collapsed]')
    }
  })
  document.body.innerHTML = `
    <aside><button id="sidebar"></button></aside>
    <div id="pane-1" data-browser-page-pane-id="page-1">
      <div id="surface-1" data-browser-annotate-surface="page-1"><canvas id="draw-1"></canvas></div>
      <div data-browser-annotate-page="page-1"><button id="palette-1"></button></div>
    </div>
    <div id="pane-2" data-browser-page-pane-id="page-2">
      <div id="surface-2" data-browser-annotate-surface="page-2"></div>
      <div data-browser-annotate-page="page-2"><button id="palette-2"></button></div>
    </div>
    <div id="surface-preview" data-browser-annotate-surface="preview-1"><div id="card-preview"></div></div>
    <div role="menu" data-slot="dropdown-menu-content"><div role="menuitem" id="menu-item"></div></div>`
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  document.body.innerHTML = ''
})

function byId(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`missing #${id}`)
  }
  return element
}

function enterMode(pageId: string, surfaceId: string): void {
  cleanups.push(registerAnnotateKeyPage(pageId, () => byId(surfaceId)))
}

function pressPointerIn(id: string): void {
  byId(id).dispatchEvent(new Event('pointerdown', { bubbles: true }))
}

describe('which page an annotate key belongs to', () => {
  it("gives a key from inside a page to that page, including Draw's canvas in its viewport", () => {
    enterMode('page-1', 'surface-1')
    enterMode('page-2', 'surface-2')

    expect(annotateEscOwner(byId('draw-1'))).toBe('page-1')
    expect(annotateLetterOwner(byId('draw-1'))).toBe('page-1')
    expect(annotateEscOwner(byId('palette-2'))).toBe('page-2')
    expect(annotateLetterOwner(byId('palette-2'))).toBe('page-2')
  })

  it('gives a key with no element behind it to the page used last, across splits', () => {
    enterMode('page-1', 'surface-1')
    enterMode('page-2', 'surface-2')
    expect(annotateEscOwner(document.body)).toBe('page-2')

    // A Draw stroke in page 1 leaves focus on the body; its keys still reach page 1, and only page 1.
    pressPointerIn('draw-1')
    expect(annotateEscOwner(document.body)).toBe('page-1')
    expect(annotateLetterOwner(document.body)).toBe('page-1')
  })

  it('never lets a hidden page own a key, even when it was used last', () => {
    enterMode('page-1', 'surface-1')
    enterMode('page-2', 'surface-2')
    byId('pane-2').setAttribute('inert', '')

    expect(resolvedAnnotatePage()).toBe('page-1')
    expect(annotateEscOwner(document.body)).toBe('page-1')
    expect(annotateEscOwner(byId('palette-2'))).toBeNull()

    byId('pane-2').removeAttribute('inert')
    byId('pane-2').setAttribute('data-test-collapsed', '')
    expect(resolvedAnnotatePage()).toBe('page-1')
  })

  it('keeps a document preview and a browser page apart', () => {
    enterMode('page-1', 'surface-1')
    enterMode('preview-1', 'surface-preview')

    expect(annotateEscOwner(byId('card-preview'))).toBe('preview-1')
    expect(annotateLetterOwner(byId('palette-1'))).toBe('page-1')
  })

  it('leaves letters from unrelated controls and menus alone, but still lets Esc reach the page', () => {
    enterMode('page-1', 'surface-1')

    expect(annotateLetterOwner(byId('sidebar'))).toBeNull()
    expect(annotateLetterOwner(byId('menu-item'))).toBeNull()
    expect(annotateEscOwner(byId('sidebar'))).toBe('page-1')
  })

  it('gives keys to no page once every page has left the mode', () => {
    enterMode('page-1', 'surface-1')
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }

    expect(annotateEscOwner(document.body)).toBeNull()
    expect(annotateLetterOwner(byId('palette-1'))).toBeNull()
  })
})
