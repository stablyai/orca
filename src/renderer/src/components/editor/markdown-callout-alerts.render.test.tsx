// @vitest-environment happy-dom

// Integration check: render Markdown through the real remark pipeline
// (gfm + breaks + our callout plugin) and confirm the callout survives to the
// DOM — validates the structural assumption (remark-breaks emits the `break`
// nodes the plugin splits on) and that react-markdown honors the data.hName.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { remarkCalloutAlerts } from './markdown-callout-alerts'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(markdown: string): void {
  act(() => {
    root.render(
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks, remarkCalloutAlerts]}>{markdown}</Markdown>
    )
  })
}

describe('callout alerts render through the real remark pipeline', () => {
  it('renders `> [!NOTE]` as a callout div with default title and body', () => {
    render('> [!NOTE]\n> Body text.')
    const alert = container.querySelector('div.md-alert.md-alert-note')
    expect(alert).not.toBeNull()
    // role="note" must survive rehype-sanitize (allowlisted on div).
    expect(alert?.getAttribute('role')).toBe('note')
    expect(alert?.querySelector('.md-alert-title')?.textContent).toBe('Note')
    expect(alert?.textContent).toContain('Body text.')
    // The literal marker must be gone.
    expect(container.textContent).not.toContain('[!NOTE]')
  })

  it('renders an Obsidian-style custom title and a warning accent class', () => {
    render('> [!warning] Careful now\n> Details.')
    const alert = container.querySelector('div.md-alert.md-alert-warning')
    expect(alert).not.toBeNull()
    expect(alert?.querySelector('.md-alert-title')?.textContent).toBe('Careful now')
    expect(alert?.textContent).toContain('Details.')
  })

  it('leaves an ordinary blockquote as a blockquote', () => {
    render('> just a quote')
    expect(container.querySelector('div.md-alert')).toBeNull()
    expect(container.querySelector('blockquote')).not.toBeNull()
  })
})
