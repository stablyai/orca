import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldIgnoreFileExplorerKeyTarget } from './useFileExplorerKeys'

class FakeHTMLElement {
  isContentEditable = false

  classList = {
    contains: (): boolean => false
  }

  constructor(
    private readonly editableMatch: boolean,
    private readonly ignoredControlMatch = false
  ) {}

  closest(selector: string): FakeHTMLElement | null {
    if (this.editableMatch && selector.includes('input')) {
      return this
    }
    if (this.ignoredControlMatch && selector.includes('data-ignore-file-explorer-keys="true"')) {
      return this
    }
    return null
  }
}

describe('shouldIgnoreFileExplorerKeyTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores input targets so text editing does not trigger explorer shortcuts', () => {
    vi.stubGlobal('HTMLElement', FakeHTMLElement)

    expect(
      shouldIgnoreFileExplorerKeyTarget(new FakeHTMLElement(true) as unknown as EventTarget)
    ).toBe(true)
  })

  it('ignores filter buttons marked outside the explorer row keyboard scope', () => {
    vi.stubGlobal('HTMLElement', FakeHTMLElement)
    vi.stubGlobal('Element', FakeHTMLElement)

    expect(
      shouldIgnoreFileExplorerKeyTarget(new FakeHTMLElement(false, true) as unknown as EventTarget)
    ).toBe(true)
  })
})
