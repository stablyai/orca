// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { captureTerminalSideQuestSelection } from './terminal-side-quest-selection'

function createPane(selection: string): ManagedPane {
  const container = document.createElement('div')
  const target = document.createElement('span')
  container.append(target)
  document.body.append(container)

  return {
    id: 4,
    leafId: 'leaf-4',
    container,
    terminal: { getSelection: () => selection }
  } as unknown as ManagedPane
}

describe('captureTerminalSideQuestSelection', () => {
  it('snapshots selected terminal text and its source pane', () => {
    const pane = createPane('  failing output  ')
    const manager = { getPanes: () => [pane] } as PaneManager

    expect(
      captureTerminalSideQuestSelection({
        manager,
        target: pane.container.firstChild,
        clientX: 240,
        clientY: 120,
        sourceLabelForPane: () => 'Build logs'
      })
    ).toMatchObject({
      paneId: 4,
      leafId: 'leaf-4',
      capturedText: 'failing output',
      sourceLabel: 'Build logs',
      point: { x: 240, y: 84 }
    })
  })

  it('returns null when the pointer is outside a pane or selection is blank', () => {
    const pane = createPane('   ')
    const manager = { getPanes: () => [pane] } as PaneManager
    const sourceLabelForPane = vi.fn(() => 'Terminal')

    expect(
      captureTerminalSideQuestSelection({
        manager,
        target: pane.container.firstChild,
        clientX: 0,
        clientY: 0,
        sourceLabelForPane
      })
    ).toBeNull()
    expect(
      captureTerminalSideQuestSelection({
        manager,
        target: document.createElement('div'),
        clientX: 0,
        clientY: 0,
        sourceLabelForPane
      })
    ).toBeNull()
    expect(sourceLabelForPane).not.toHaveBeenCalled()
  })
})
