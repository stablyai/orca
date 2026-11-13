import { describe, expect, it } from 'vitest'
import { createPdfLinkHistory } from './pdf-link-history'

const top = { pageNumber: 1, top: 792, left: 0 }
const section = { pageNumber: 5, top: 792, left: 0 }
const appendix = { pageNumber: 9, top: 400, left: 0 }

describe('createPdfLinkHistory', () => {
  it('drops forward history when a new link is followed, like a browser', () => {
    const history = createPdfLinkHistory()
    history.recordJump(top)
    expect(history.goBack(section)).toEqual(top)
    expect(history.getState()).toEqual({ canGoBack: false, canGoForward: true })

    history.recordJump(top)
    expect(history.getState()).toEqual({ canGoBack: true, canGoForward: false })
    expect(history.goForward(appendix)).toBeNull()
  })

  it('records one entry when one click reaches the link service twice', () => {
    const history = createPdfLinkHistory()
    history.recordJump(top)
    history.recordJump(top)
    expect(history.goBack(section)).toEqual(top)
    expect(history.goBack(top)).toBeNull()
  })
})
