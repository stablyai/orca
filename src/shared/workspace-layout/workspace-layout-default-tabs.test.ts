import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'

let next = 0
/** The ids a window proposes for one default tab. */
function ids() {
  next += 1
  return {
    tabId: `default-tab-${next}`,
    leafId: `00000000-0000-4000-9000-${String(next).padStart(12, '0')}`
  }
}

describe('applyDefaultTabs', () => {
  it('makes every default tab under the window’s ids, with its title and colour, and the mark', () => {
    const proposed = [ids(), ids(), ids()]
    const { model, results } = build(testContext(), [
      {
        type: 'applyDefaultTabs',
        workspace: WS,
        tabs: [
          { ...proposed[0]!, title: 'Server', color: 'blue', creation: { launchAgent: 'claude' } },
          proposed[1]!,
          { ...proposed[2]!, title: 'Logs' }
        ]
      }
    ])
    const created = results[0]!.createdTabs!
    expect(created.map(({ tabId, leafId }) => ({ tabId, leafId }))).toEqual(proposed)
    expect(model.workspaces[WS]!.groups[0]!.tabOrder).toEqual(created.map((tab) => tab.tabId))
    const [first, second, third] = created.map((tab) => terminalTab(model, tab.tabId))
    expect(first).toMatchObject({ customTitle: 'Server', color: 'blue' })
    expect(first!.terminal).toMatchObject({ defaultTitle: 'Terminal 1', launchAgent: 'claude' })
    expect(second).toMatchObject({ customTitle: null, color: null })
    expect(second!.terminal.defaultTitle).toBe('Terminal 2')
    expect(third!.customTitle).toBe('Logs')
    expect(created.map((tab) => tab.paneKey)).toEqual(
      created.map((tab) => `${tab.tabId}:${tab.leafId}`)
    )
    expect(model.records.defaultTabsAppliedByWorkspace).toEqual({ [WS]: true })
  })

  it('starts every new pane', () => {
    const applied = applyLayoutCommand(
      build(testContext(), []).model,
      { type: 'applyDefaultTabs', workspace: WS, tabs: [ids(), ids()] },
      testContext()
    )
    expect(applied.ok && applied.effects.startPaneKeys).toEqual(
      applied.ok ? applied.result.createdTabs!.map((tab) => tab.paneKey) : []
    )
  })

  it('makes nothing once a workspace’s default tabs were applied', () => {
    const ctx = testContext()
    const { model, results } = build(ctx, [
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{ ...ids(), title: 'Server' }] },
      { type: 'applyDefaultTabs', workspace: WS, tabs: [{ ...ids(), title: 'Again' }] }
    ])
    expect(results[1]!.createdTabs).toEqual([])
    expect(model.workspaces[WS]!.tabs).toHaveLength(1)
  })

  it('marks a workspace with no templates without creating it', () => {
    const { model, results } = build(testContext(), [
      { type: 'applyDefaultTabs', workspace: WS, tabs: [] }
    ])
    expect(results[0]!.createdTabs).toEqual([])
    expect(model.workspaces[WS]).toBeUndefined()
    expect(model.records.defaultTabsAppliedByWorkspace).toEqual({ [WS]: true })
  })
})
