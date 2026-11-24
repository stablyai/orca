import { expect, it } from 'vitest'
import { applyLayoutCommand } from '../workspace-layout-commands'
import { build, terminalTab, testContext, WS } from './workspace-layout-command.test-fixture'
import type { WorkerTabStamp } from '../../orchestration/workers/worker-tab-stamp'

function stamp(dispatchId: string): WorkerTabStamp {
  return {
    origin: {
      dispatchId,
      runId: 'run',
      taskId: 'task',
      taskTitle: 'Review keyboard navigation',
      parent: { kind: 'pane', paneKey: 'coordinator:pane' },
      coordinator: { kind: 'pane', paneKey: 'coordinator:pane' }
    }
  }
}

it('a worker pane moved into a new tab retains its classification and leaves the user shell unstamped', () => {
  const ctx = testContext()
  const created = build(ctx, [
    {
      type: 'createTerminalTab',
      workspace: WS,
      tabId: 'worker-a',
      leafId: '00000000-0000-4000-8000-000000000001',
      workerTab: stamp('worker')
    }
  ])
  const split = build(
    ctx,
    [
      {
        type: 'splitPane',
        workspace: WS,
        tabId: 'worker-a',
        leafId: '00000000-0000-4000-8000-000000000001',
        direction: 'horizontal',
        newLeafId: '00000000-0000-4000-8000-000000000002'
      }
    ],
    created.model
  )
  const moved = build(
    ctx,
    [
      {
        type: 'movePaneToNewTab',
        workspace: WS,
        tabId: 'worker-a',
        leafId: '00000000-0000-4000-8000-000000000001',
        windowDetach: { tabId: 'worker-moved', ptyId: null }
      }
    ],
    split.model
  )
  expect(terminalTab(moved.model, 'worker-a').workerTab).toBeUndefined()
  expect(terminalTab(moved.model, 'worker-moved').workerTab?.origin).toEqual({
    dispatchId: 'worker',
    runId: 'run',
    taskId: 'task',
    taskTitle: 'Review keyboard navigation',
    parent: { kind: 'pane', paneKey: 'coordinator:pane' },
    coordinator: { kind: 'pane', paneKey: 'coordinator:pane' },
    workerLeafId: '00000000-0000-4000-8000-000000000001'
  })
  expect(terminalTab(moved.model, 'worker-a').panes.root).toEqual({
    type: 'leaf',
    leafId: '00000000-0000-4000-8000-000000000002'
  })
})

it('refuses another worker tab as a pane-move destination without changing the model', () => {
  const ctx = testContext()
  const created = build(ctx, [
    {
      type: 'createTerminalTab',
      workspace: WS,
      tabId: 'worker-a',
      leafId: '00000000-0000-4000-8000-000000000001',
      workerTab: stamp('first')
    },
    {
      type: 'createTerminalTab',
      workspace: WS,
      tabId: 'worker-b',
      leafId: '00000000-0000-4000-8000-000000000002',
      workerTab: stamp('second')
    }
  ])
  const result = applyLayoutCommand(
    created.model,
    {
      type: 'movePane',
      workspace: WS,
      tabId: 'worker-a',
      leafId: '00000000-0000-4000-8000-000000000001',
      targetLeafId: '00000000-0000-4000-8000-000000000002',
      side: 'left'
    },
    ctx
  )
  expect(result).toMatchObject({ ok: false, code: 'worker_tab_conflict' })
  expect(terminalTab(created.model, 'worker-a').panes.root).toEqual({
    type: 'leaf',
    leafId: '00000000-0000-4000-8000-000000000001'
  })
  expect(terminalTab(created.model, 'worker-b').panes.root).toEqual({
    type: 'leaf',
    leafId: '00000000-0000-4000-8000-000000000002'
  })
})

it('refuses rebinding a worker stamp from a user leaf while accepting its own worker leaf', () => {
  const ctx = testContext()
  const created = build(ctx, [
    {
      type: 'createTerminalTab',
      workspace: WS,
      tabId: 'worker-a',
      leafId: '00000000-0000-4000-8000-000000000001',
      workerTab: stamp('first')
    }
  ])
  const refused = applyLayoutCommand(
    created.model,
    {
      type: 'setTabProps',
      workspace: WS,
      tabId: 'worker-a',
      workerTabCurrent: {
        ...stamp('next').origin,
        workerLeafId: '00000000-0000-4000-8000-000000000002'
      }
    },
    ctx
  )
  expect(refused).toEqual({ ok: false, code: 'invalid_params' })
  const rebound = build(
    ctx,
    [
      {
        type: 'setTabProps',
        workspace: WS,
        tabId: 'worker-a',
        workerTabCurrent: {
          ...stamp('next').origin,
          workerLeafId: '00000000-0000-4000-8000-000000000001',
          parent: { kind: 'session', lineageRootSessionId: 'new-creator' }
        }
      }
    ],
    created.model
  )
  expect(terminalTab(rebound.model, 'worker-a').workerTab?.origin.dispatchId).toBe('first')
  expect(terminalTab(rebound.model, 'worker-a').workerTab?.current).toEqual({
    dispatchId: 'next',
    runId: 'run',
    taskId: 'task',
    taskTitle: 'Review keyboard navigation',
    parent: { kind: 'session', lineageRootSessionId: 'new-creator' },
    coordinator: { kind: 'pane', paneKey: 'coordinator:pane' },
    workerLeafId: '00000000-0000-4000-8000-000000000001'
  })
})
