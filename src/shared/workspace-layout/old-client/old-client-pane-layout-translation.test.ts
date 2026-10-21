import { describe, expect, it } from 'vitest'
import { UpdatePaneLayout } from '../../rpc-contract/session-tabs-schemas-params'
import type { TerminalPaneLayoutNode } from '../../terminal-tab-types'
import { translateUpdatePaneLayout } from './old-client-pane-layout-translation'
import { build, terminalTab, testContext, WS } from '../workspace-layout-command.test-fixture'
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

/** Params as an old desktop sends them (`use-terminal-pane-layout-persistence.ts`), parsed as today. */
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
  it('sends nothing for the tree it already has', () => {
    const { model, tabId } = threePanes()
    const root = terminalTab(model, tabId).panes.root
    expect(translate(model, tabId, sent(tabId, { root }))).toEqual({
      commands: [],
      structureRefused: false
    })
  })

  it('turns a divider drag into setPaneRatios', () => {
    const { ctx, model, tabId, a, b, c } = threePanes()
    const root = split(
      'vertical',
      leafNode(a),
      split('vertical', leafNode(b), leafNode(c), 0.3),
      0.7
    )
    const translation = translate(model, tabId, sent(tabId, { root }))
    expect(translation.commands).toEqual([{ type: 'setPaneRatios', workspace: WS, tabId, root }])
    expect(terminalTab(build(ctx, translation.commands, model).model, tabId).panes.root).toEqual(
      root
    )
  })

  it('turns one moved pane into movePane, then the sent ratios', () => {
    const { ctx, model, tabId, a, b, c } = threePanes()
    // C dragged to the left of A.
    const root = split(
      'vertical',
      split('vertical', leafNode(c), leafNode(a), 0.4),
      leafNode(b),
      0.6
    )
    const translation = translate(model, tabId, sent(tabId, { root }))
    expect(translation).toEqual({
      structureRefused: false,
      commands: [
        { type: 'movePane', workspace: WS, tabId, leafId: c, targetLeafId: a, side: 'left' },
        { type: 'setPaneRatios', workspace: WS, tabId, root }
      ]
    })
    expect(terminalTab(build(ctx, translation.commands, model).model, tabId).panes.root).toEqual(
      root
    )
  })

  it('moves below a pane, from either side of the sent split', () => {
    const { ctx, model, tabId, a, b, c } = threePanes()
    const root = split('vertical', split('horizontal', leafNode(a), leafNode(c)), leafNode(b))
    const translation = translate(model, tabId, sent(tabId, { root }))
    expect(translation.commands[0]).toEqual({
      type: 'movePane',
      workspace: WS,
      tabId,
      leafId: c,
      targetLeafId: a,
      side: 'bottom'
    })
    expect(terminalTab(build(ctx, translation.commands, model).model, tabId).panes.root).toEqual(
      expect.objectContaining({ first: split('horizontal', leafNode(a), leafNode(c)) })
    )
  })

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

  it('sets and clears the chat pane; absent leaves it', () => {
    const { ctx, model, tabId, b } = threePanes()
    expect(translate(model, tabId, sent(tabId, { root: null, chatLeafId: b })).commands).toEqual([
      { type: 'setChatPane', workspace: WS, tabId, leafId: b }
    ])
    const chat = build(ctx, [{ type: 'setChatPane', workspace: WS, tabId, leafId: b }], model).model
    expect(translate(chat, tabId, sent(tabId, { root: null })).commands).toEqual([])
    expect(translate(chat, tabId, sent(tabId, { root: null, chatLeafId: b })).commands).toEqual([])
    expect(translate(chat, tabId, sent(tabId, { root: null, chatLeafId: null })).commands).toEqual([
      { type: 'setChatPane', workspace: WS, tabId, leafId: null }
    ])
  })

  it('orders titles, then the chat pane, then the structure, and the list applies as one', () => {
    const { ctx, model, tabId, a, b, c } = threePanes()
    const root = split('vertical', leafNode(a), split('vertical', leafNode(b), leafNode(c), 0.25))
    const translation = translate(
      model,
      tabId,
      sent(tabId, { root, titlesByLeafId: { [c]: 'tests' }, chatLeafId: c })
    )
    expect(translation.commands.map((command) => command.type)).toEqual([
      'renamePane',
      'setChatPane',
      'setPaneRatios'
    ])
    const applied = build(ctx, translation.commands, model).model
    expect(terminalTab(applied, tabId).panes).toEqual({ root, chatLeafId: c })
    expect(applied.workspaces[WS]!.leaves?.[c]?.title).toBe('tests')
  })
})

type Panes = ReturnType<typeof threePanes>
const NEW_LEAF = '99999999-9999-4999-8999-999999999999'
