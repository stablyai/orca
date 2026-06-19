import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWorkspaceBoardKeepOpenTarget } from './use-workspace-kanban-outside-dismiss'

class FakeNode {
  parentElement: FakeElement | null = null
}

class FakeElement extends FakeNode {
  private readonly attributes: ReadonlySet<string>

  constructor(attributes: readonly string[] = [], parentElement: FakeElement | null = null) {
    super()
    this.attributes = new Set(attributes)
    this.parentElement = parentElement
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }

  private matches(selector: string): boolean {
    return selector
      .split(',')
      .map((part) => part.trim())
      .some((part) => this.attributes.has(part))
  }
}

describe('workspace kanban outside dismiss keep-open targets', () => {
  beforeEach(() => {
    vi.stubGlobal('Node', FakeNode)
    vi.stubGlobal('Element', FakeElement)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the board open when a Sonner toast action is clicked', () => {
    const toast = new FakeElement(['[data-sonner-toast]'])
    const action = new FakeElement([], toast)

    expect(isWorkspaceBoardKeepOpenTarget(action as unknown as EventTarget)).toBe(true)
  })

  it('keeps the board open when the contextual tour panel is clicked', () => {
    const panel = new FakeElement(['[data-contextual-tour-panel]'])
    const nextButton = new FakeElement([], panel)

    expect(isWorkspaceBoardKeepOpenTarget(nextButton as unknown as EventTarget)).toBe(true)
  })

  it('does not keep the board open for generic outside content', () => {
    const target = new FakeElement()

    expect(isWorkspaceBoardKeepOpenTarget(target as unknown as EventTarget)).toBe(false)
  })
})
