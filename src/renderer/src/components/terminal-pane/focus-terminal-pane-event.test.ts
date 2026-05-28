import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { handleFocusTerminalPaneDetail } from './focus-terminal-pane-event'

const LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222' as TerminalLeafId

class MockClassList {
  private classes = new Set<string>()

  add(value: string): void {
    this.classes.add(value)
  }

  remove(value: string): void {
    this.classes.delete(value)
  }

  contains(value: string): boolean {
    return this.classes.has(value)
  }
}

function createPaneElement(): HTMLElement {
  return { classList: new MockClassList() } as unknown as HTMLElement
}

function createManager(args?: { numericPaneId?: number | null; leafId?: TerminalLeafId }) {
  const container = createPaneElement()
  const numericPaneId = args?.numericPaneId ?? 7
  const leafId = args?.leafId ?? LEAF_ID
  return {
    container,
    manager: {
      getNumericIdForLeaf: vi.fn(() => numericPaneId),
      getPanes: vi.fn(() => [
        {
          id: 7,
          leafId,
          container
        }
      ]),
      setActivePane: vi.fn()
    }
  }
}

describe('handleFocusTerminalPaneDetail', () => {
  it('focuses and flashes only after the target leaf resolves', () => {
    const { container, manager } = createManager()
    const acknowledgeAgents = vi.fn()
    const surfaceStaleAgentRow = vi.fn()

    handleFocusTerminalPaneDetail(
      {
        tabId: 'tab-1',
        leafId: LEAF_ID,
        ackPaneKeyOnSuccess: `tab-1:${LEAF_ID}`,
        flashFocusedPane: true
      },
      {
        tabId: 'tab-1',
        manager,
        acknowledgeAgents,
        surfaceStaleAgentRow
      }
    )

    expect(manager.setActivePane).toHaveBeenCalledWith(7, { focus: true })
    expect(container.classList.contains('pane-focus-rim-flash')).toBe(true)
    expect(acknowledgeAgents).toHaveBeenCalledWith([`tab-1:${LEAF_ID}`])
    expect(surfaceStaleAgentRow).not.toHaveBeenCalled()
  })

  it('requests follow-output scrolling after resolving the target leaf', () => {
    const { manager } = createManager()
    const scrollToBottomIfOutputSinceLastView = vi.fn()

    handleFocusTerminalPaneDetail(
      {
        tabId: 'tab-1',
        leafId: LEAF_ID,
        scrollToBottomIfOutputSinceLastView: true
      },
      {
        tabId: 'tab-1',
        manager,
        acknowledgeAgents: vi.fn(),
        surfaceStaleAgentRow: vi.fn(),
        scrollToBottomIfOutputSinceLastView
      }
    )

    expect(manager.setActivePane).toHaveBeenCalledWith(7, { focus: true })
    expect(scrollToBottomIfOutputSinceLastView).toHaveBeenCalledWith(7)
  })

  it('does not focus, flash, or ack when the numeric pane no longer owns the leaf', () => {
    const { container, manager } = createManager({ leafId: OTHER_LEAF_ID })
    const acknowledgeAgents = vi.fn()
    const surfaceStaleAgentRow = vi.fn()

    handleFocusTerminalPaneDetail(
      {
        tabId: 'tab-1',
        leafId: LEAF_ID,
        ackPaneKeyOnSuccess: `tab-1:${LEAF_ID}`,
        flashFocusedPane: true
      },
      {
        tabId: 'tab-1',
        manager,
        acknowledgeAgents,
        surfaceStaleAgentRow
      }
    )

    expect(manager.setActivePane).not.toHaveBeenCalled()
    expect(container.classList.contains('pane-focus-rim-flash')).toBe(false)
    expect(acknowledgeAgents).not.toHaveBeenCalled()
    expect(surfaceStaleAgentRow).toHaveBeenCalledWith('tab-1', LEAF_ID)
  })
})
