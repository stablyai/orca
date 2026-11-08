import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import { asLoaded, build, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { saveWorkspaceLayout } from './workspace-layout-save'

const PTY = `${WS}@@cli00001`

function withCliTab(bound: boolean) {
  const context = testContext()
  const { model, results } = build(context, [{ type: 'createTerminalTab', workspace: WS }])
  const { tabId, leafId, paneKey } = results[0]!
  const workspace = model.workspaces[WS]!
  const next: WorkspaceLayoutModel = bound
    ? {
        ...model,
        workspaces: { [WS]: { ...workspace, leaves: { [leafId!]: { ptyId: PTY } } } }
      }
    : model
  return { context, model: next, tabId: tabId!, leafId: leafId!, paneKey: paneKey! }
}

const adopt = (extra: { recordedPaneKey?: string; incarnationId?: string } = {}) => ({
  type: 'createTerminalTab' as const,
  workspace: WS,
  tabId: 'window-tab',
  leafId: '00000000-0000-4000-8000-0000000000ff',
  adopt: { ptyId: PTY, ...extra }
})

describe('a live terminal no pane shows, through main', () => {
  it('names the pane main already shows it in, and makes no tab', () => {
    const { context, model, tabId, leafId, paneKey } = withCliTab(true)
    const applied = applyLayoutCommand(model, adopt(), context)
    expect(applied).toMatchObject({ ok: true, result: { tabId, leafId, paneKey } })
    expect(applied.ok && applied.model.workspaces[WS]!.tabs).toHaveLength(1)
    expect(applied.ok && applied.effects.startPaneKeys).toEqual([])
  })

  it('binds the pane the host recorded for it while main has not bound it yet', () => {
    const { context, model, tabId, leafId, paneKey } = withCliTab(false)
    const applied = applyLayoutCommand(
      model,
      adopt({ recordedPaneKey: paneKey, incarnationId: 'inc-1' }),
      context
    )
    expect(applied).toMatchObject({ ok: true, result: { tabId, paneKey } })
    expect(applied.ok && applied.model.workspaces[WS]!.tabs).toHaveLength(1)
    // Bound, so the pane reattaches to the running terminal instead of starting a second one.
    expect(applied.ok && applied.model.workspaces[WS]!.leaves?.[leafId]).toEqual({
      ptyId: PTY,
      incarnationId: 'inc-1'
    })
    expect(applied.ok && applied.effects.startPaneKeys).toEqual([])
  })

  it('makes a new tab when the recorded pane now shows another terminal', () => {
    const { context, model, paneKey, leafId } = withCliTab(false)
    const rebound: WorkspaceLayoutModel = {
      ...model,
      workspaces: {
        [WS]: { ...model.workspaces[WS]!, leaves: { [leafId]: { ptyId: `${WS}@@other0001` } } }
      }
    }
    const applied = applyLayoutCommand(rebound, adopt({ recordedPaneKey: paneKey }), context)
    if (!applied.ok) {
      throw new Error(applied.code)
    }
    expect(applied.result).toMatchObject({ tabId: 'window-tab' })
    expect(applied.model.workspaces[WS]!.tabs).toHaveLength(2)
    expect(applied.model.workspaces[WS]!.leaves?.['00000000-0000-4000-8000-0000000000ff']).toEqual({
      ptyId: PTY
    })
  })

  it('otherwise shows it in a new tab bound to it, starting nothing', () => {
    const context = testContext()
    const applied = applyLayoutCommand(build(context, []).model, adopt(), context)
    if (!applied.ok) {
      throw new Error(applied.code)
    }
    expect(applied.result).toMatchObject({ tabId: 'window-tab' })
    expect(applied.effects.startPaneKeys).toEqual([])
    expect(applied.model.workspaces[WS]!.leaves).toEqual({
      '00000000-0000-4000-8000-0000000000ff': { ptyId: PTY }
    })
    const saved = saveWorkspaceLayout(asLoaded(applied.model))
    expect(saved.tabsByWorktree?.[WS]?.map((row) => row.ptyId)).toEqual([PTY])
  })
})
