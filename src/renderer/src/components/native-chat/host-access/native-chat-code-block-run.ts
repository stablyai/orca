import { useCallback, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  runCodeBlockScript,
  type CodeBlockRunState
} from '../../../../../shared/code-block-terminal-run'
import type { CodeBlockScript } from '../../../../../shared/code-block-terminal-script'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

// Outside React, so a run and its output survive the transcript unmounting its block.
const runs = new Map<string, CodeBlockRunState>()
const listeners = new Set<() => void>()

function setRun(key: string, state: CodeBlockRunState): void {
  runs.set(key, state)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The latest run of the block at `key`, if Play ran it. */
export function useNativeChatCodeBlockRun(key: string): CodeBlockRunState | undefined {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => runs.get(key), [key])
  )
}

/** Runs `block` in the chat's workspace on the chat's own host, unless the block at `key` still runs. */
export function startNativeChatCodeBlockRun(
  key: string,
  target: RuntimeClientTarget,
  worktreeId: string,
  block: CodeBlockScript
): void {
  if (runs.get(key)?.status === 'running') {
    return
  }
  void runCodeBlockScript({
    worktreeId,
    block,
    onUpdate: (state) => setRun(key, state),
    call: (method, params) => callRuntimeRpc(target, method, params)
  })
}
