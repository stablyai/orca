import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import * as z from 'zod'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/runtime/files/watching/worktree-file-change-event'

const PipelineChange = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pipelinesChanged'),
    projectId: z.string(),
    workspaceId: z.string(),
    instanceId: z.string(),
    runId: z.string(),
    revision: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal('gitStatusChanged'),
    repoId: z.string(),
    worktreeIds: z.array(z.string()).optional()
  })
])
type Change =
  | z.infer<typeof PipelineChange>
  | { type: 'reconnect' }
  | { type: 'worktreeFilesChanged'; worktreePath: string }
const listeners = new Map<(event: Change) => void, (error: unknown) => void>()
let generation = 0
let stream: { unsubscribe: () => void } | undefined
let retry: ReturnType<typeof setTimeout> | undefined
let failures = 0

function close() {
  generation++
  const closing = stream
  stream = undefined
  if (retry) {
    clearTimeout(retry)
    retry = undefined
  }
  closing?.unsubscribe()
}
function open() {
  close()
  const opening = generation
  const current = () => listeners.size > 0 && opening === generation
  const lost = (error: unknown) => {
    if (!current()) {
      return
    }
    close()
    listeners.forEach((onError) => onError(error))
    retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)))
  }
  void subscribeRuntimeRpc(
    { kind: 'local' },
    'runtime.clientEvents.subscribe',
    {},
    {
      onEvent: (value) => {
        if (!current() || !value || typeof value !== 'object' || !('type' in value)) {
          return
        }
        if (value.type === 'end') {
          lost(new Error('pipeline_event_stream_closed'))
          return
        }
        if (value.type === 'ready') {
          failures = 0
          listeners.forEach((_, listener) => listener({ type: 'reconnect' }))
        } else if (value.type === 'pipelinesChanged' || value.type === 'gitStatusChanged') {
          const event = PipelineChange.safeParse(value)
          if (event.success) {
            listeners.forEach((_, listener) => listener(event.data))
          }
        }
      },
      onError: lost,
      onClose: () => lost(new Error('pipeline_event_stream_closed'))
    }
  ).then((handle) => {
    if (current()) {
      stream = handle
    } else {
      handle.unsubscribe()
    }
  }, lost)
}
function wake() {
  if (retry && listeners.size) {
    failures = 0
    open()
  }
}
function sourceChanged(event: WindowEventMap[typeof ORCA_WORKTREE_FILE_CHANGE_EVENT]) {
  const { payload, runtimeEnvironmentId } = event.detail
  if (runtimeEnvironmentId || payload.connectionId) {
    return
  }
  listeners.forEach((_, listener) =>
    listener({ type: 'worktreeFilesChanged', worktreePath: payload.worktreePath })
  )
}
export function subscribePipelineRunChanges(
  listener: (event: Change) => void,
  onError: (error: unknown) => void
) {
  listeners.set(listener, onError)
  if (listeners.size === 1) {
    window.addEventListener('online', wake)
    window.addEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, sourceChanged)
    open()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      close()
      failures = 0
      window.removeEventListener('online', wake)
      window.removeEventListener(ORCA_WORKTREE_FILE_CHANGE_EVENT, sourceChanged)
    }
  }
}
