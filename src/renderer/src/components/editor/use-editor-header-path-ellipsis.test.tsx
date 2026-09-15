// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useEditorHeaderPathEllipsis } from './use-editor-header-path-ellipsis'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHARACTER_WIDTH = 10

const ICLOUD_PATH =
  '/Users/example/Library/Mobile Documents/iCloud~md~obsidian/Documents/Ebrain/Projects/Onboarding Questions.md'

function PathLabel({ label }: { label: string }): React.JSX.Element {
  const { pathRef, displayLabel } = useEditorHeaderPathEllipsis(label)
  return (
    <button type="button" ref={pathRef} title={label}>
      {displayLabel}
    </button>
  )
}

describe('useEditorHeaderPathEllipsis', () => {
  let container: HTMLDivElement
  let root: Root
  let availableCharacters: number
  let originalClientWidth: PropertyDescriptor | undefined
  let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    availableCharacters = 45

    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === 'BUTTON' ? availableCharacters * CHARACTER_WIDTH : 0
      }
    })

    // Why: happy-dom reports zero-size boxes, so the measuring probe needs a
    // deterministic monospace width for the candidate strings it is handed.
    originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      return { width: (this.textContent ?? '').length * CHARACTER_WIDTH, height: 16 } as DOMRect
    }
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
  })

  it('renders a left-ellipsized path when the label overflows', async () => {
    await act(async () => {
      root.render(<PathLabel label={ICLOUD_PATH} />)
    })

    const button = container.querySelector('button')
    expect(button?.textContent?.startsWith('…/')).toBe(true)
    expect(ICLOUD_PATH.endsWith(button?.textContent?.slice(2) ?? '')).toBe(true)
  })

  it('keeps the full path in the title while the label is shortened', async () => {
    await act(async () => {
      root.render(<PathLabel label={ICLOUD_PATH} />)
    })

    const button = container.querySelector('button')
    expect(button?.getAttribute('title')).toBe(ICLOUD_PATH)
    expect(button?.textContent).not.toBe(ICLOUD_PATH)
  })

  it('renders the full path when it fits', async () => {
    availableCharacters = ICLOUD_PATH.length
    await act(async () => {
      root.render(<PathLabel label={ICLOUD_PATH} />)
    })

    expect(container.querySelector('button')?.textContent).toBe(ICLOUD_PATH)
  })

  it('remeasures when the path changes without a resize', async () => {
    availableCharacters = ICLOUD_PATH.length
    await act(async () => {
      root.render(<PathLabel label={ICLOUD_PATH} />)
    })
    expect(container.querySelector('button')?.textContent).toBe(ICLOUD_PATH)

    availableCharacters = 50
    await act(async () => {
      root.render(<PathLabel label={`${ICLOUD_PATH} (diff)`} />)
    })

    const button = container.querySelector('button')
    expect(button?.textContent?.startsWith('…/')).toBe(true)
    expect(button?.textContent?.endsWith('(diff)')).toBe(true)
  })

  it('falls back to the file name alone when it is the only thing that fits', async () => {
    availableCharacters = 20
    await act(async () => {
      root.render(<PathLabel label={ICLOUD_PATH} />)
    })

    expect(container.querySelector('button')?.textContent).toBe('Onboarding Questions.md')
  })
})
