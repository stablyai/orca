import { describe, expect, it } from 'vitest'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutContext } from './workspace-layout-command-types'
import { build, CLEAN_EXIT, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { checkWorkspaceLayoutModelRules } from './workspace-layout-model-rules'
import { applyPaneOutcomeChanges } from './workspace-layout-pane-outcomes'
import type { ProcessExitFacts } from './workspace-layout-process-exit'
import { applyLayoutTransition } from './workspace-layout-transitions'

/** A terminal tab with `panes` panes, none started. */
function setup(panes: 1 | 2) {
  const context = testContext()
  const created = build(context, [{ type: 'createTerminalTab', workspace: WS }])
  const { tabId, leafId } = created.results[0]!
  if (panes === 1) {
    return { context, model: created.model, tabId: tabId!, leafId: leafId! }
  }
  const split = build(
    context,
    [{ type: 'splitPane', workspace: WS, tabId: tabId!, leafId: leafId!, direction: 'vertical' }],
    created.model
  )
  return { context, model: split.model, tabId: tabId!, leafId: leafId! }
}

function bind(model: WorkspaceLayoutModel, tabId: string, leafId: string): WorkspaceLayoutModel {
  const started = applyLayoutTransition(model, {
    type: 'processStarted',
    workspace: WS,
    paneKey: `${tabId}:${leafId}`,
    ptyId: 'pty-1',
    incarnationId: 'inc-1'
  })
  if (!started.ok) {
    throw new Error(started.code)
  }
  return started.model
}

describe('startPane and restartPane', () => {
  it('starts a pane once whether the second startPane lands before or after the bind', () => {
    const { model, tabId, leafId, context } = setup(1)
    const paneKey = `${tabId}:${leafId}`
    for (const bindFirst of [false, true]) {
      // The runtime holds a start token from the first start until its spawn binds.
      let starting = false
      const withToken: LayoutContext = { ...context, isStarting: () => starting }
      const start = (from: WorkspaceLayoutModel) => {
        const result = applyLayoutCommand(
          from,
          { type: 'startPane', workspace: WS, paneKey },
          withToken
        )
        if (!result.ok) {
          throw new Error(result.code)
        }
        starting ||= result.effects.startPaneKeys.length > 0
        return result
      }
      const first = start(model)
      const settled = bindFirst ? bind(first.model, tabId, leafId) : first.model
      starting = !bindFirst
      const second = start(settled)
      expect([first.effects.startPaneKeys, second.effects.startPaneKeys]).toEqual([[paneKey], []])
    }
  })

  it('leaves a bound pane alone; only restartPane replaces its terminal', () => {
    const { model, tabId, leafId, context } = setup(1)
    const bound = bind(model, tabId, leafId)
    const paneKey = `${tabId}:${leafId}`
    const start = applyLayoutCommand(bound, { type: 'startPane', workspace: WS, paneKey }, context)
    expect(start.ok && start.effects).toEqual({ stopPtyIds: [], startPaneKeys: [] })
    expect(start.ok && start.model).toEqual(bound)
    const restart = applyLayoutCommand(
      bound,
      { type: 'restartPane', workspace: WS, paneKey },
      context
    )
    expect(restart.ok && restart.effects).toEqual({
      stopPtyIds: ['pty-1'],
      startPaneKeys: [paneKey]
    })
    expect(restart.ok && restart.outcomes).toEqual({ [leafId]: null })
  })

  it('clears the last outcome when a start is issued, not when it is a no-op', () => {
    const { model, tabId, leafId, context } = setup(1)
    const paneKey = `${tabId}:${leafId}`
    const start = applyLayoutCommand(model, { type: 'startPane', workspace: WS, paneKey }, context)
    expect(start.ok && applyPaneOutcomeChanges({ [leafId]: 'failed' }, start.outcomes)).toEqual({})
    const busy = applyLayoutCommand(
      model,
      { type: 'startPane', workspace: WS, paneKey },
      { ...context, isStarting: () => true }
    )
    expect(busy.ok && busy.outcomes).toBeUndefined()
  })
})

describe('processExited', () => {
  const exit = (overrides: Partial<ProcessExitFacts>): ProcessExitFacts => ({
    exitCode: 1,
    local: false,
    spawnedFresh: false,
    tabHadPaneAtConnect: false,
    restored: false,
    inputWritten: true,
    outputReceived: true,
    ...overrides
  })

  function exitPane(panes: 1 | 2, facts: ProcessExitFacts) {
    const { model, tabId, leafId } = setup(panes)
    const bound = bind(model, tabId, leafId)
    const result = applyLayoutTransition(bound, {
      type: 'processExited',
      surface: { worktreeId: WS, terminalTabId: tabId, leafId, ptyId: 'pty-1' },
      exit: facts
    })
    if (!result.ok) {
      throw new Error(result.code)
    }
    expect(checkWorkspaceLayoutModelRules([result.model], [bound])).toEqual([])
    const tab = result.model.workspaces[WS]!.tabs.find((entry) => entry.id === tabId)
    const inTab = tab?.kind === 'terminal' && JSON.stringify(tab.panes.root).includes(leafId)
    const leaf = result.model.workspaces[WS]!.leaves?.[leafId]
    return {
      pane: !inTab ? 'retired' : leaf?.ptyId ? 'bound' : 'unbound',
      tabClosed: !tab,
      outcome: result.outcomes?.[leafId],
      leaf,
      bound,
      model: result.model
    }
  }

  it('retires an ordinary pane on exit code 0, closing a tab left without panes', () => {
    expect(exitPane(1, exit({ exitCode: 0, local: true }))).toMatchObject({
      pane: 'retired',
      tabClosed: true,
      outcome: null
    })
    expect(exitPane(2, exit({ exitCode: 0 }))).toMatchObject({ pane: 'retired', tabClosed: false })
  })

  it("keeps today's keep cases as exited, with the same ids and binding", () => {
    const newborn = { spawnedFresh: true, inputWritten: false }
    const split = { ...newborn, tabHadPaneAtConnect: true }
    const keeps = [
      // A local process that exits non-zero.
      { panes: 2 as const, facts: exit({ local: true }) },
      // A sole newborn that dies before input, whatever the code.
      { panes: 1 as const, facts: exit(newborn) },
      { panes: 1 as const, facts: exit({ ...newborn, exitCode: 0, local: true }) },
      { panes: 1 as const, facts: exit({ ...newborn, exitCode: 0 }) },
      // A split into a tab with a live pane, not restored, dead before input or output, whatever
      // the code; it need not be a fresh spawn.
      { panes: 2 as const, facts: exit({ ...split, outputReceived: false }) },
      { panes: 2 as const, facts: exit({ ...split, exitCode: 0, outputReceived: false }) },
      { panes: 2 as const, facts: exit({ ...split, spawnedFresh: false, outputReceived: false }) }
    ]
    for (const { panes, facts } of keeps) {
      const kept = exitPane(panes, facts)
      expect(kept).toMatchObject({ pane: 'bound', outcome: 'exited' })
      expect(kept.model).toBe(kept.bound)
    }
  })

  it('retires every other proven exit', () => {
    const silent = { inputWritten: false, outputReceived: false }
    const retires = [
      { panes: 1 as const, facts: exit({}) },
      { panes: 1 as const, facts: exit({ spawnedFresh: true }) },
      { panes: 1 as const, facts: exit({ exitCode: 0, spawnedFresh: true }) },
      { panes: 2 as const, facts: exit({ exitCode: 0, local: true, spawnedFresh: true }) },
      // A fresh spawn in a restored multi-pane tab is not a split into a live tab.
      { panes: 2 as const, facts: exit({ ...silent, spawnedFresh: true }) },
      // Neither is a restored terminal, nor a split that printed output.
      { panes: 2 as const, facts: exit({ ...silent, tabHadPaneAtConnect: true, restored: true }) },
      {
        panes: 2 as const,
        facts: exit({ ...silent, tabHadPaneAtConnect: true, outputReceived: true })
      }
    ]
    for (const { panes, facts } of retires) {
      expect(exitPane(panes, facts)).toMatchObject({ pane: 'retired', outcome: null })
    }
  })

  it('unbinds and keeps the pane on -1 or attach absence, whatever else is known', () => {
    for (const facts of [
      exit({ exitCode: -1 }),
      exit({ exitCode: -1, local: true }),
      exit({ exitCode: 0, attachAbsent: true })
    ]) {
      const unbound = exitPane(1, facts)
      expect(unbound).toMatchObject({ pane: 'unbound', tabClosed: false, outcome: null })
      expect(unbound.leaf).toBeUndefined()
      expect(unbound.model.legacy.topologyRevisionByRepoId).toEqual(
        unbound.bound.legacy.topologyRevisionByRepoId
      )
    }
  })

  it('leaves a pane that now shows another terminal alone', () => {
    const { model, tabId, leafId } = setup(1)
    const bound = bind(model, tabId, leafId)
    for (const exitCode of [0, 1, -1]) {
      const result = applyLayoutTransition(bound, {
        type: 'processExited',
        surface: { worktreeId: WS, terminalTabId: tabId, leafId, ptyId: 'pty-old' },
        exit: { ...CLEAN_EXIT, exitCode }
      })
      expect(result.ok && result.model).toBe(bound)
      expect(result.ok && result.outcomes).toBeUndefined()
    }
  })
})
