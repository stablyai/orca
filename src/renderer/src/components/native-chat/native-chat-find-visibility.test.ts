// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { nativeChatFindGeometry, nativeChatFindScrollDelta } from './native-chat-find-visibility'

type Box = { top: number; bottom: number; left: number; right: number }

function placeAt(target: Element | Range, box: Box): void {
  Object.defineProperty(target, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      DOMRect.fromRect({
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top
      })
  })
}

const VIEW = { top: 100, bottom: 700, left: 0, right: 800 }
const BAR = { top: 108, bottom: 144, left: 444, right: 784 }

/** A transcript holding `text` inside `boxStyle`d boxes, outermost first; returns its match. */
function transcriptWith(...boxStyles: Partial<CSSStyleDeclaration>[]): {
  transcript: HTMLElement
  boxes: HTMLElement[]
  match: Range
} {
  const transcript = document.createElement('div')
  placeAt(transcript, VIEW)
  let parent: HTMLElement = transcript
  const boxes = boxStyles.map((style) => {
    const box = document.createElement('div')
    Object.assign(box.style, style)
    parent.append(box)
    parent = box
    return box
  })
  const text = document.createTextNode('alpha')
  parent.append(text)
  document.body.append(transcript)
  const match = document.createRange()
  match.selectNodeContents(text)
  return { transcript, boxes, match }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('native chat find visibility', () => {
  it('counts a match in the top band as visible when the bar is not over it', () => {
    const { transcript, match } = transcriptWith()
    placeAt(match, { top: 112, bottom: 130, left: 20, right: 60 })
    expect(nativeChatFindGeometry(transcript).inView(match, BAR)).toBe(true)
    placeAt(match, { top: 112, bottom: 130, left: 500, right: 540 })
    expect(nativeChatFindGeometry(transcript).inView(match, BAR)).toBe(false)
    placeAt(match, { top: 60, bottom: 78, left: 20, right: 60 })
    expect(nativeChatFindGeometry(transcript).inView(match, BAR)).toBe(false)
  })

  it('scrolls a code line sideways to a match past its right edge', () => {
    const { transcript, boxes, match } = transcriptWith({ overflowX: 'auto' })
    placeAt(boxes[0], { top: 200, bottom: 260, left: 40, right: 640 })
    placeAt(match, { top: 220, bottom: 238, left: 900, right: 940 })
    const geometry = nativeChatFindGeometry(transcript)
    expect(geometry.inView(match, BAR)).toBe(false)
    expect(geometry.clippedAway(match)).toBe(false)
    geometry.scrollIntoBoxes(match)
    expect(boxes[0].scrollLeft).toBe(580)
  })

  it('drops text a box that cannot scroll cuts off, such as a folded prompt', () => {
    const { transcript, boxes, match } = transcriptWith({ overflow: 'hidden' })
    placeAt(boxes[0], { top: 200, bottom: 376, left: 40, right: 640 })
    Object.defineProperty(boxes[0], 'scrollHeight', { value: 600 })
    Object.defineProperty(boxes[0], 'clientHeight', { value: 176 })
    placeAt(match, { top: 500, bottom: 518, left: 60, right: 100 })
    expect(nativeChatFindGeometry(transcript).clippedAway(match)).toBe(true)
    placeAt(match, { top: 300, bottom: 318, left: 60, right: 100 })
    expect(nativeChatFindGeometry(transcript).clippedAway(match)).toBe(false)
  })

  it('centres a revealed match below the bar only when the bar shares its column', () => {
    expect(
      nativeChatFindScrollDelta({ top: 900, bottom: 920, left: 500, right: 540 }, VIEW, BAR)
    ).toBe(910 - (144 + 700) / 2)
    expect(
      nativeChatFindScrollDelta({ top: 900, bottom: 920, left: 20, right: 60 }, VIEW, BAR)
    ).toBe(910 - (100 + 700) / 2)
  })
})
