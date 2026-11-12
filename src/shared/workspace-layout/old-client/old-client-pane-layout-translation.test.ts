import { describe, expect, it } from 'vitest'
import { UpdatePaneLayout } from '../../rpc-contract/session-tabs-schemas-params'
import type { TerminalPaneLayoutNode } from '../terminal-tab-types'
import { translateUpdatePaneLayout } from './old-client-pane-layout-translation'
import {
  build,
  terminalTab,
  testContext,
  WS
} from '../commands/workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from '../workspace-layout-model'

const leafNode = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (
  direction: 'vertical' | 'horizontal',
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode,
  ratio?: number
): TerminalPaneLayoutNode => ({
  type: 'split',
  direction,
  first,
  second,
  ...(ratio !== undefined ? { ratio } : {})
})

/** One tab with panes A | B | C side by side, as a desktop splits right twice. */
function threePanes() {
  const ctx = testContext()
  const created = build(ctx, [{ type: 'createTerminalTab', workspace: WS }])
  const tabId = created.results[0]!.tabId!
  const a = created.results[0]!.leafId!
  const first = build(
    ctx,
    [{ type: 'splitPane', workspace: WS, tabId, leafId: a, direction: 'vertical' }],
    created.model
  )
  const b = first.results[0]!.leafId!
  const second = build(
    ctx,
    [{ type: 'splitPane', workspace: WS, tabId, leafId: b, direction: 'vertical' }],
    first.model
  )
  const c = second.results[0]!.leafId!
  return { ctx, model: second.model, tabId, a, b, c }
}

/** Parse older desktop persistence params from use-terminal-pane-layout-persistence.ts. */
function sent(tabId: string, fields: Record<string, unknown>) {
  return UpdatePaneLayout.parse({
    worktree: WS,
    tabId,
    expandedLeafId: null,
    intent: 'gesture',
    ...fields
  })
}

function translate(model: WorkspaceLayoutModel, tabId: string, params: ReturnType<typeof sent>) {
  return translateUpdatePaneLayout(WS, model.workspaces[WS]!, terminalTab(model, tabId), params)
}

describe('translateUpdatePaneLayout (rule 11)', () => {
  it.each([
    [
      'a pane added',
      (p: Panes) =>
        split(
          'vertical',
          leafNode(p.a),
          split('vertical', leafNode(p.b), split('vertical', leafNode(p.c), leafNode(NEW_LEAF)))
        )
    ],
    ['a pane removed', (p: Panes) => split('vertical', leafNode(p.a), leafNode(p.b))],
    [
      'two panes moved',
      (p: Panes) =>
        split('horizontal', leafNode(p.c), split('horizontal', leafNode(p.b), leafNode(p.a)))
    ],
    [
      'a pane repeated',
      (p: Panes) =>
        split('vertical', leafNode(p.a), split('vertical', leafNode(p.a), leafNode(p.c)))
    ]
  ])('refuses the structure for %s, and still applies titles and the chat pane', (_, tree) => {
    const panes = threePanes()
    const { model, tabId, a, b } = panes
    const translation = translate(
      model,
      tabId,
      sent(tabId, { root: tree(panes), titlesByLeafId: { [a]: 'server' }, chatLeafId: b })
    )
    expect(translation).toEqual({
      structureRefused: true,
      commands: [
        { type: 'renamePane', workspace: WS, tabId, leafId: a, title: 'server' },
        { type: 'setChatPane', workspace: WS, tabId, leafId: b }
      ]
    })
  })

  it('renames only changed panes; a pane missing from the sent titles loses its title', () => {
    const { ctx, model, tabId, a, b, c } = threePanes()
    const titled = build(
      ctx,
      [
        { type: 'renamePane', workspace: WS, tabId, leafId: a, title: 'logs' },
        { type: 'renamePane', workspace: WS, tabId, leafId: b, title: 'shell' }
      ],
      model
    ).model
    const translation = translate(
      titled,
      tabId,
      sent(tabId, { root: null, titlesByLeafId: { [a]: 'logs', [c]: 'build' } })
    )
    expect(translation.commands).toEqual([
      { type: 'renamePane', workspace: WS, tabId, leafId: b, title: null },
      { type: 'renamePane', workspace: WS, tabId, leafId: c, title: 'build' }
    ])
    // No title map leaves titles alone.
    expect(translate(titled, tabId, sent(tabId, { root: null })).commands).toEqual([])
  })
})

type Panes = ReturnType<typeof threePanes>
const NEW_LEAF = '99999999-9999-4999-8999-999999999999'
