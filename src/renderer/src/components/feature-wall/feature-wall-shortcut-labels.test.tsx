import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserAnimatedVisual } from './BrowserAnimatedVisual'
import { EditorAnimatedVisual } from './EditorAnimatedVisual'
import { ReviewPRViewAnimatedVisual } from './ReviewPRViewAnimatedVisual'
import { WorkbenchAnimatedVisual } from './WorkbenchAnimatedVisual'

const originalUserAgent = navigator.userAgent

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent
  })
}

describe('feature wall shortcut labels', () => {
  afterEach(() => {
    setUserAgent(originalUserAgent)
  })

  it('renders Windows shortcut copy in workbench and browser visuals', () => {
    setUserAgent('Windows NT 10.0')

    const html = [
      renderToStaticMarkup(<BrowserAnimatedVisual reducedMotion />),
      renderToStaticMarkup(<WorkbenchAnimatedVisual reducedMotion />),
      renderToStaticMarkup(<EditorAnimatedVisual reducedMotion />),
      renderToStaticMarkup(<ReviewPRViewAnimatedVisual reducedMotion />)
    ].join('\n')

    expect(html).toContain('Ctrl+Shift+B')
    expect(html).toContain('Ctrl+Shift+D')
    expect(html).toContain('Alt+Shift+D')
    expect(html).toContain('Ctrl+B')
    expect(html).toContain('Ctrl+I')
    expect(html).toContain('Checks')
    expect(html).not.toContain('⌘')
  })
})
