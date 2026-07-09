import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { resolveTerminalHandleForPaneKey } from '@/components/dashboard/agent-row-orchestration-clipboard'

type CallRuntime = (request: {
  method: string
  params?: Record<string, unknown>
}) => Promise<RuntimeRpcResponse<unknown>>

export type OrchestrationActionKind = 'dispatch' | 'send' | 'ask'

export type ActiveTerminalPaneKeyState = {
  activeTabType: string | null
  activeTabId: string | null
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string }[] | undefined>
  terminalLayoutsByTabId: Record<
    string,
    { activeLeafId?: string | null; root?: TerminalPaneLayoutNode | null } | undefined
  >
  agentStatusByPaneKey?: Record<string, unknown>
}

// Why: the focused terminal is the natural coordinator for sidebar-driven
// dispatch — same identity the agent list already highlights as "focused pane".
export function getActiveTerminalPaneKey(state: ActiveTerminalPaneKeyState): string | null {
  if (state.activeTabType !== 'terminal' || !state.activeTabId) {
    return null
  }
  const activeLeafId = state.terminalLayoutsByTabId[state.activeTabId]?.activeLeafId
  if (!activeLeafId || !isTerminalLeafId(activeLeafId)) {
    return null
  }
  return makePaneKey(state.activeTabId, activeLeafId)
}

function collectLeafIds(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

function collectWorktreeTerminalPaneKeys(
  state: ActiveTerminalPaneKeyState,
  worktreeId: string
): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const push = (paneKey: string): void => {
    if (seen.has(paneKey)) {
      return
    }
    seen.add(paneKey)
    keys.push(paneKey)
  }

  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const layout = state.terminalLayoutsByTabId[tab.id]
    const leafIds = collectLeafIds(layout?.root ?? null)
    if (leafIds.length === 0 && layout?.activeLeafId) {
      leafIds.push(layout.activeLeafId)
    }
    for (const leafId of leafIds) {
      if (isTerminalLeafId(leafId)) {
        push(makePaneKey(tab.id, leafId))
      }
    }
  }

  // Why: agent rows can exist before layout leaves are fully hydrated; also
  // prefer known agents as coordinator candidates.
  for (const paneKey of Object.keys(state.agentStatusByPaneKey ?? {})) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const tabBelongs = (state.tabsByWorktree[worktreeId] ?? []).some(
      (tab) => tab.id === parsed.tabId
    )
    if (tabBelongs) {
      push(paneKey)
    }
  }

  return keys
}

// Why: right-clicking an agent often focuses that same terminal, so "focused =
// coordinator" would equal the worker. Prefer focused only when distinct; else
// pick another terminal in the worker's worktree.
export function resolveCoordinatorPaneKey(args: {
  workerPaneKey: string
  workerWorktreeId: string | null
  state: ActiveTerminalPaneKeyState
}): string | null {
  const focused = getActiveTerminalPaneKey(args.state)
  if (focused && focused !== args.workerPaneKey) {
    return focused
  }

  const worktreeId = args.workerWorktreeId ?? args.state.activeWorktreeId
  if (!worktreeId) {
    return null
  }

  const candidates = collectWorktreeTerminalPaneKeys(args.state, worktreeId)
  const other = candidates.find((paneKey) => paneKey !== args.workerPaneKey)
  return other ?? null
}

function assertOk(response: RuntimeRpcResponse<unknown>): unknown {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

function readTaskId(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.task) || typeof result.task.id !== 'string') {
    throw new Error('Task create did not return a task id')
  }
  return result.task.id
}

function readAskAnswer(result: unknown): { answer: string | null; timedOut: boolean } {
  if (!isRecord(result)) {
    return { answer: null, timedOut: true }
  }
  const answer = typeof result.answer === 'string' ? result.answer : null
  const timedOut = result.timedOut === true
  return { answer, timedOut }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function resolveCoordinatorAndWorkerHandles(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  callRuntime: CallRuntime
}): Promise<{ coordinatorHandle: string; workerHandle: string }> {
  if (!args.coordinatorPaneKey) {
    throw new Error(
      'No other terminal found to use as coordinator. Open/focus another agent terminal in this worktree, then try again.'
    )
  }
  if (args.coordinatorPaneKey === args.workerPaneKey) {
    throw new Error(
      'Coordinator and worker are the same terminal. Open/focus another agent terminal as coordinator.'
    )
  }
  const callRuntimeForPane = args.callRuntime as Parameters<
    typeof resolveTerminalHandleForPaneKey
  >[0]['callRuntime']
  const [coordinatorHandle, workerHandle] = await Promise.all([
    resolveTerminalHandleForPaneKey({
      paneKey: args.coordinatorPaneKey,
      callRuntime: callRuntimeForPane
    }),
    resolveTerminalHandleForPaneKey({
      paneKey: args.workerPaneKey,
      callRuntime: callRuntimeForPane
    })
  ])
  if (coordinatorHandle === workerHandle) {
    throw new Error(
      'Coordinator and worker resolve to the same terminal handle. Focus a different terminal as coordinator.'
    )
  }
  return { coordinatorHandle, workerHandle }
}

export async function dispatchTaskToAgent(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  spec: string
  inject?: boolean
  callRuntime: CallRuntime
}): Promise<{
  taskId: string
  workerHandle: string
  coordinatorHandle: string
  injected: boolean
}> {
  const spec = args.spec.trim()
  if (!spec) {
    throw new Error('Task spec is required')
  }
  const { coordinatorHandle, workerHandle } = await resolveCoordinatorAndWorkerHandles({
    workerPaneKey: args.workerPaneKey,
    coordinatorPaneKey: args.coordinatorPaneKey,
    callRuntime: args.callRuntime
  })

  const createResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.taskCreate',
      params: {
        spec,
        callerTerminalHandle: coordinatorHandle
      }
    })
  )
  const taskId = readTaskId(createResult)

  const dispatchResult = assertOk(
    await args.callRuntime({
      method: 'orchestration.dispatch',
      params: {
        task: taskId,
        to: workerHandle,
        from: coordinatorHandle,
        inject: args.inject !== false
      }
    })
  )
  const injected =
    isRecord(dispatchResult) && typeof dispatchResult.injected === 'boolean'
      ? dispatchResult.injected
      : false

  return { taskId, workerHandle, coordinatorHandle, injected }
}

export async function sendMessageToAgent(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  subject: string
  body?: string
  callRuntime: CallRuntime
}): Promise<{ workerHandle: string; coordinatorHandle: string }> {
  const subject = args.subject.trim()
  if (!subject) {
    throw new Error('Subject is required')
  }
  const { coordinatorHandle, workerHandle } = await resolveCoordinatorAndWorkerHandles({
    workerPaneKey: args.workerPaneKey,
    coordinatorPaneKey: args.coordinatorPaneKey,
    callRuntime: args.callRuntime
  })
  assertOk(
    await args.callRuntime({
      method: 'orchestration.send',
      params: {
        to: workerHandle,
        from: coordinatorHandle,
        subject,
        body: args.body?.trim() || undefined,
        type: 'status'
      }
    })
  )
  return { workerHandle, coordinatorHandle }
}

export async function askAgent(args: {
  workerPaneKey: string
  coordinatorPaneKey: string | null
  question: string
  timeoutMs?: number
  callRuntime: CallRuntime
}): Promise<{
  workerHandle: string
  coordinatorHandle: string
  answer: string | null
  timedOut: boolean
}> {
  const question = args.question.trim()
  if (!question) {
    throw new Error('Question is required')
  }
  const { coordinatorHandle, workerHandle } = await resolveCoordinatorAndWorkerHandles({
    workerPaneKey: args.workerPaneKey,
    coordinatorPaneKey: args.coordinatorPaneKey,
    callRuntime: args.callRuntime
  })
  const result = assertOk(
    await args.callRuntime({
      method: 'orchestration.ask',
      params: {
        to: workerHandle,
        from: coordinatorHandle,
        question,
        // Why: UI should not block for the CLI default (10m); keep a short wait
        // so the dialog can surface timeout vs answer without hanging forever.
        timeoutMs: args.timeoutMs ?? 120_000
      }
    })
  )
  const { answer, timedOut } = readAskAnswer(result)
  return { workerHandle, coordinatorHandle, answer, timedOut }
}
