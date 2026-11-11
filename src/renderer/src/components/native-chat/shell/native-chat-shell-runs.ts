import { useRef, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import {
  appendNativeChatShellOutput,
  nativeChatShellCommandBlock
} from '../../../../../shared/native-chat/input/native-chat-shell-command'
import type {
  AgentSessionShellCommandExit,
  AgentSessionShellCommandFrame,
  AgentSessionShellOutputChunk
} from '../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'
import type { NativeChatShellSink } from './native-chat-shell-subscription'

export type NativeChatShellRun = {
  id: string
  scope: string
  anchorId: string | null
  awaitingTurn: boolean
  command: string
  startedAt: number
  finishedAt?: number
  directory: string | null
  output: readonly AgentSessionShellOutputChunk[]
  exit?: AgentSessionShellCommandExit
  stopped?: boolean
  error?: string
  added: boolean
  sending?: boolean
}

type NativeChatShellHost = {
  run: (command: string, sink: NativeChatShellSink) => () => void
  anchor: () => { id: string | null; awaitingTurn: boolean }
}

let runs: readonly NativeChatShellRun[] = []
const hosts = new Map<string, readonly NativeChatShellHost[]>()
const cancels = new Map<string, () => void>()
const listeners = new Set<() => void>()
let nextId = 0

function write(next: readonly NativeChatShellRun[]): void {
  runs = next
  listeners.forEach((listener) => listener())
}

function update(
  id: string,
  change: (run: NativeChatShellRun) => Partial<NativeChatShellRun>
): void {
  if (runs.some((run) => run.id === id)) {
    write(runs.map((run) => (run.id === id ? { ...run, ...change(run) } : run)))
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function releaseSubscription(id: string): void {
  const cancel = cancels.get(id)
  cancels.delete(id)
  cancel?.()
}

function applyFrame(id: string, frame: AgentSessionShellCommandFrame): void {
  if (frame.type === 'started') {
    update(id, () => ({ directory: frame.directory }))
    return
  }
  if (frame.type === 'output') {
    update(id, (run) => ({ output: frame.chunks.reduce(appendNativeChatShellOutput, run.output) }))
    return
  }
  const { type: _type, ...exit } = frame
  update(id, (run) =>
    run.finishedAt !== undefined
      ? {}
      : {
          exit,
          finishedAt: Date.now(),
          ...(exit.output ? { output: exit.output } : {}),
          ...(exit.error ? { error: exit.error } : {})
        }
  )
  releaseSubscription(id)
}

function sameRuns(a: readonly NativeChatShellRun[], b: readonly NativeChatShellRun[]): boolean {
  return a.length === b.length && a.every((run, index) => run === b[index])
}

export function useNativeChatShellRuns(
  select: (run: NativeChatShellRun) => boolean
): readonly NativeChatShellRun[] {
  const selected = useRef<readonly NativeChatShellRun[]>([])
  return useSyncExternalStore(subscribe, () => {
    const next = runs.filter(select)
    if (!sameRuns(next, selected.current)) {
      selected.current = next
    }
    return selected.current
  })
}

export function nativeChatShellRunOutput(run: NativeChatShellRun): string {
  return run.output.map((chunk) => chunk.text).join('')
}

export function registerNativeChatShellHost(scope: string, host: NativeChatShellHost): () => void {
  hosts.set(scope, [...(hosts.get(scope) ?? []), host])
  return () => {
    const remaining = (hosts.get(scope) ?? []).filter((registered) => registered !== host)
    if (remaining.length > 0) {
      hosts.set(scope, remaining)
    } else {
      hosts.delete(scope)
    }
  }
}

export function runNativeChatShellCommand(scope: string, command: string): void {
  const host = hosts.get(scope)?.at(-1)
  if (!host) {
    return
  }
  const id = `shell-${++nextId}`
  const anchor = host.anchor()
  write([
    ...runs,
    {
      id,
      scope,
      anchorId: anchor.id,
      awaitingTurn: anchor.awaitingTurn,
      command,
      startedAt: Date.now(),
      directory: null,
      output: [],
      added: false
    }
  ])
  const cancel = host.run(command, {
    frame: (frame) => applyFrame(id, frame),
    fail: (error) => {
      update(id, (run) =>
        run.finishedAt === undefined
          ? {
              finishedAt: Date.now(),
              error: extractIpcErrorMessage(
                error,
                translate('components.native-chat.composer.shellCommandFailed', 'Command failed.')
              )
            }
          : {}
      )
      releaseSubscription(id)
    }
  })
  if (runs.find((run) => run.id === id)?.finishedAt === undefined) {
    cancels.set(id, cancel)
  } else {
    cancel()
  }
}

export function stopNativeChatShellRun(id: string): void {
  if (!cancels.has(id)) {
    return
  }
  releaseSubscription(id)
  update(id, () => ({ finishedAt: Date.now(), stopped: true }))
}

export function anchorNativeChatShellRunsAfterTurn(scope: string, anchorId: string): void {
  if (runs.some((run) => run.scope === scope && run.awaitingTurn)) {
    write(
      runs.map((run) =>
        run.scope === scope && run.awaitingTurn ? { ...run, anchorId, awaitingTurn: false } : run
      )
    )
  }
}

export function reanchorOrphanedNativeChatShellRuns(
  scope: string,
  liveMessages: readonly { id: string }[],
  anchorId: string | null
): void {
  if (!runs.some((run) => run.scope === scope && run.anchorId !== null)) {
    return
  }
  const live = new Set(liveMessages.map(({ id }) => id))
  const orphaned = (run: NativeChatShellRun): boolean =>
    run.scope === scope && run.anchorId !== null && !live.has(run.anchorId)
  if (runs.some(orphaned)) {
    write(runs.map((run) => (orphaned(run) ? { ...run, anchorId } : run)))
  }
}

export function setNativeChatShellRunAdded(id: string, added: boolean): void {
  update(id, () => ({ added }))
}

export function dismissNativeChatShellRun(id: string): void {
  releaseSubscription(id)
  write(runs.filter((run) => run.id !== id))
}

export function isSendableNativeChatShellRun(run: NativeChatShellRun, scope: string): boolean {
  return (
    run.scope === scope && run.added && !run.sending && run.finishedAt !== undefined && !run.error
  )
}

export function claimNativeChatShellContext(scope: string): { text: string; ids: string[] } | null {
  const added = runs.filter((run) => isSendableNativeChatShellRun(run, scope))
  if (added.length === 0) {
    return null
  }
  const ids = added.map((run) => run.id)
  write(runs.map((run) => (ids.includes(run.id) ? { ...run, sending: true } : run)))
  return {
    text: added
      .map((run) =>
        nativeChatShellCommandBlock(run.command, {
          output: nativeChatShellRunOutput(run),
          exitCode: run.exit?.exitCode ?? null,
          timedOut: run.exit?.timedOut ?? false,
          outputTruncated: run.exit?.outputTruncated ?? false,
          stopped: run.stopped,
          directory: run.directory
        })
      )
      .join('\n\n'),
    ids
  }
}

export function releaseNativeChatShellRuns(ids: readonly string[]): void {
  if (ids.length > 0) {
    write(runs.map((run) => (ids.includes(run.id) ? { ...run, sending: false } : run)))
  }
}

export function consumeNativeChatShellRuns(ids: readonly string[]): void {
  write(runs.filter((run) => !ids.includes(run.id)))
}
