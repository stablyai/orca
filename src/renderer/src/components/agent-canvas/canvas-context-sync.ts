import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { resolveTarget } from './canvas-runtime-target'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toHostSessionTabId } from '../../../../shared/terminal-surface-id'
import {
  canvasContextReplaceSchema,
  canvasContextReceiptSchema,
  type CanvasContextReceipt,
  type CanvasContextReplace
} from '../../../../shared/canvas-agent-context'
import type { CanvasDocument } from './agent-canvas-document'
import { indexCanvasAgents } from './canvas-agent-bindings'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { Tab } from '../../../../shared/tab-types'
import { CANVAS_STORAGE_PREFIX, readCanvasDocument } from './use-agent-canvas-document'

export type CanvasContextView = { nodes: CanvasContextReceipt['nodes']; error: string | null }
export const EMPTY_CANVAS_CONTEXT: CanvasContextView = { nodes: {}, error: null }
type SyncEntry = {
  view: CanvasContextView
  signature: string
  revision: number
  target: RuntimeClientTarget
  request: CanvasContextReplace
  queue: Promise<unknown>
  queued?: CanvasContextReplace
  timer?: ReturnType<typeof setTimeout>
}
const entries = new Map<string, SyncEntry>()
const listeners = new Set<() => void>()
const unavailable = new Map<string, CanvasContextView>()
const closing = new Set<string>()
export const subscribeCanvasContext = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const readCanvasContext = (scope: string) =>
  unavailable.get(scope) ?? entries.get(scope)?.view ?? EMPTY_CANVAS_CONTEXT
function reportUnavailable(scope: string, error: string): void {
  const entry = entries.get(scope)
  if (entry?.timer) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
  if (unavailable.get(scope)?.error === error) {
    return
  }
  unavailable.set(scope, { nodes: {}, error })
  for (const listener of listeners) {
    listener()
  }
}
function publish(entry: SyncEntry, view: CanvasContextView) {
  if (JSON.stringify(entry.view) === JSON.stringify(view)) {
    return
  }
  entry.view = view
  for (const listener of listeners) {
    listener()
  }
}

function enqueue(entry: SyncEntry): Promise<unknown> {
  const request = entry.request
  if (entry.queued === request) {
    return entry.queue
  }
  entry.queued = request
  const target = entry.target
  entry.queue = entry.queue
    .then(async () => {
      if (request !== entry.request) {
        return
      }
      try {
        const result = canvasContextReceiptSchema.parse(
          await callRuntimeRpc<CanvasContextReceipt>(target, 'agentHooks.canvasContext', request, {
            timeoutMs: 8000,
            suppressFeatureInteraction: true
          })
        )
        if (request === entry.request) {
          if (result.revision !== request.revision) {
            entry.revision = Math.max(entry.revision, result.revision)
            entry.signature = ''
            publish(entry, { nodes: {}, error: 'Reconciling context with the execution host…' })
            return
          }
          publish(entry, { nodes: result.nodes, error: null })
        }
      } catch (error) {
        if (request !== entry.request) {
          return
        }
        const unsupported = hasRuntimeRpcErrorCode(error, 'method_not_found')
        publish(entry, {
          nodes: Object.fromEntries(
            request.bindings.map((binding) => [
              binding.nodeId,
              { state: unsupported ? 'unsupported' : 'unverifiable', provider: binding.provider }
            ])
          ),
          error: unsupported
            ? 'Update this execution host to enable canvas context.'
            : error instanceof Error
              ? `Context not updated: ${error.message}`
              : 'Context synchronization failed.'
        })
      }
    })
    .finally(() => {
      if (entry.queued === request) {
        entry.queued = undefined
      }
    })
  return entry.queue
}

export function syncCanvasContext(
  scope: string,
  document: CanvasDocument,
  cards: DashboardCard[],
  refresh = false
): void {
  if (closing.has(scope)) {
    return
  }
  const target = resolveTarget(scope)
  if (!target) {
    reportUnavailable(scope, 'Context is unverifiable: execution host unavailable.')
    return
  }
  const bindings: CanvasContextReplace['bindings'] = []
  const index = indexCanvasAgents(cards)
  for (const node of document.nodes.filter((node) => node.kind === 'agent')) {
    const ids = new Set(
      document.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)
    )
    const notes = document.nodes
      .filter((note) => note.kind === 'note' && ids.has(note.id))
      .map(({ id, title, content }) => ({ id, title, content }))
    const card = index.get(node.agentKey ?? node.agentTabId ?? '')
    if (!card?.ptyId || !card.leafId) {
      if (!notes.length) {
        continue
      }
      reportUnavailable(scope, 'Waiting for the agent terminal to become available.')
      return
    }
    const provider = card.agentType
    if (provider !== 'codex' && provider !== 'claude' && provider !== 'cursor') {
      if (!notes.length) {
        continue
      }
      reportUnavailable(scope, 'Automatic context supports Codex, Claude Code, and Cursor CLI.')
      return
    }
    bindings.push({
      nodeId: node.id,
      paneKey: makePaneKey(toHostSessionTabId(card.tabId), card.leafId),
      worktreeId: card.worktreeId,
      ptyId: card.ptyId,
      provider: provider as 'codex' | 'claude' | 'cursor',
      name: node.title,
      collaborationPaused: document.collaborationPaused === true,
      peers: [
        ...new Set(
          document.edges.flatMap((edge) => {
            const other =
              edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null
            return other &&
              document.nodes.some((item) => item.id === other && item.kind === 'agent')
              ? [other]
              : []
          })
        )
      ],
      notes
    })
  }
  const signature = JSON.stringify([target, bindings])
  let entry = entries.get(scope)
  if (entry?.signature === signature && !refresh && !unavailable.has(scope)) {
    return
  }
  if (!entry && !bindings.length) {
    return
  }
  if (!entry) {
    entry = {
      view: EMPTY_CANVAS_CONTEXT,
      signature: '',
      revision: 0,
      target,
      request: { canvasId: scope, revision: 0, bindings: [] },
      queue: Promise.resolve()
    }
    entries.set(scope, entry)
  }
  if (entry.signature !== signature) {
    entry.revision = Math.max(Date.now(), entry.revision + 1)
    entry.target = target
    entry.request = { canvasId: scope, revision: entry.revision, bindings }
    const parsed = canvasContextReplaceSchema.safeParse(entry.request)
    if (!parsed.success) {
      reportUnavailable(
        scope,
        'Context limit: 32 notes, 32,000 characters per agent (9,000 for Cursor).'
      )
      return
    }
    entry.signature = signature
    publish(entry, { nodes: {}, error: null })
  }
  if (unavailable.delete(scope)) {
    for (const listener of listeners) {
      listener()
    }
  }
  if (entry.timer) {
    return
  }
  const current = entry
  entry.timer = setTimeout(() => {
    current.timer = undefined
    enqueue(current)
  }, 200)
}

export async function clearClosedCanvasContext(tab: Tab): Promise<void> {
  const scope = JSON.stringify(['workspace-tab', tab.executionHostId, tab.worktreeId, tab.id])
  const entry = entries.get(scope)
  const saved = readCanvasDocument(CANVAS_STORAGE_PREFIX + scope)
  if (!entry && !saved.error && !saved.document.edges.length) {
    return
  }
  const target = resolveTarget(scope)
  if (!target) {
    throw new Error(
      'Reconnect the execution host before closing this canvas and removing its context.'
    )
  }
  closing.add(scope)
  if (entry?.timer) {
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
  const request = {
    canvasId: scope,
    revision: Math.max(Date.now(), (entry?.revision ?? 0) + 1),
    bindings: []
  }
  if (entry) {
    entry.request = request
    entry.revision = request.revision
    entry.signature = ''
    await entry.queue
  }
  try {
    const options = { timeoutMs: 8000, suppressFeatureInteraction: true }
    let result = canvasContextReceiptSchema.parse(
      await callRuntimeRpc(target, 'agentHooks.canvasContext', request, options)
    )
    if (result.revision > request.revision) {
      request.revision = result.revision + 1
      result = canvasContextReceiptSchema.parse(
        await callRuntimeRpc(target, 'agentHooks.canvasContext', request, options)
      )
    }
    if (result.revision !== request.revision || Object.keys(result.nodes).length) {
      throw new Error('Canvas context removal was not acknowledged. Retry closing the canvas.')
    }
  } catch (error) {
    closing.delete(scope)
    throw error
  }
  entries.delete(scope)
  unavailable.delete(scope)
  setTimeout(() => closing.delete(scope), 0)
}
