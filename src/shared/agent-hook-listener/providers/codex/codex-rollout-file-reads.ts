import type { HookListenerState } from '../../listener-state'
import {
  readJsonlCursorBytes,
  readJsonlFirstRecordAsync,
  RolloutReadBatch,
  scheduleRolloutRead,
  type RolloutReadLog,
  type RolloutReadPriority
} from './codex-rollout-async-reads'
import { applyJsonlCursorBytes } from './codex-rollout-jsonl-format'
import {
  commitCodexRolloutRead,
  type CodexRolloutFile,
  type CodexRolloutState
} from './codex-rollout-state'
import { isCodexStatusTranscriptLine } from './codex-status-transcript-line'
import { codexRolloutReadPriority } from './codex-rollout-read-plan'
import { applyCodexSubagentIdentityRead, type CodexSubagentRoster } from './codex-subagent-roster'

/** What a rollout read needs from the follower that started it. */
export type CodexRolloutReadContext = {
  state: HookListenerState
  log?: RolloutReadLog
  /** Promotes a file's queued read when something more urgent waits on it. */
  raiseRead: WeakMap<CodexRolloutFile, (priority: RolloutReadPriority) => void>
  publish: (paneKey: string) => void
  pump: (paneKey: string, tail: boolean) => void
}

export function readCodexRolloutFile(
  ctx: CodexRolloutReadContext,
  pane: { readonly key: string },
  rollout: CodexRolloutState,
  file: CodexRolloutFile,
  tailDue = false
): void {
  const roster = ctx.state.codexSubagentRosterByPaneKey.get(pane.key)
  const priority = codexRolloutReadPriority(rollout, roster, file, tailDue)
  if (file.reading) {
    file.readAgain = true
    // A held approval must not wait behind tails for a read already queued for its file.
    ctx.raiseRead.get(file)?.(priority)
    return
  }
  file.reading = true
  const asRoot = rollout.root === file
  const filePath = file.cursor.filePath
  const attachedTo = (paneKey: string): boolean =>
    ctx.state.codexRolloutByPaneKey.get(paneKey) === rollout &&
    (asRoot ? rollout.root === file : rollout.childFiles.get(filePath) === file)
  // A file its pane stopped following while the read waited for a slot is never read.
  const batch = new RolloutReadBatch(() => attachedTo(pane.key))
  // Taken when the read starts: what it can satisfy is what was asked before its bytes were read.
  let start = { epoch: 0, satisfies: 0, at: 0, childHooks: new Map<string, number>() }
  const read = scheduleRolloutRead(
    filePath,
    `${pane.key} ${filePath}`,
    batch,
    () => {
      start = {
        epoch: rollout.epoch,
        satisfies: file.wanted,
        at: Date.now(),
        childHooks: new Map(
          Array.from(
            ctx.state.codexSubagentRosterByPaneKey.get(pane.key) ?? [],
            ([id, child]) => [id, child.hooks] as const
          )
        )
      }
      return readJsonlCursorBytes({ ...file.cursor }, batch)
    },
    { priority, log: ctx.log }
  )
  ctx.raiseRead.set(file, read.raise)
  const retry = (): void => {
    file.reading = false
    if (attachedTo(pane.key) && (file.readAgain || file.wanted > file.resolved)) {
      file.readAgain = false
      readCodexRolloutFile(ctx, pane, rollout, file)
    }
  }
  void read.outcome
    .then((result) => {
      if (result.status === 'skipped') {
        batch.release()
        file.reading = false
        return
      }
      if (result.status === 'timedOut') {
        // The row keeps its last state; the file is read again once this I/O ends, never stacked on it.
        void read.settled.then(() => {
          batch.release()
          retry()
        })
        return
      }
      file.reading = false
      const paneKey = pane.key
      const attached = attachedTo(paneKey)
      let current = attached && (!asRoot || rollout.epoch === start.epoch)
      // Over the byte budget, the bytes wait for the next read.
      if (current && result.value !== 'deferred') {
        const records = applyJsonlCursorBytes(
          file.cursor,
          result.value,
          isCodexStatusTranscriptLine
        )
        if (records === 'stale') {
          current = false
          file.readAgain = true
        } else {
          commitCodexRolloutRead(
            rollout,
            file,
            records,
            start.satisfies,
            start.childHooks,
            Date.now(),
            start.at
          )
        }
      }
      batch.release()
      if (attached && file.readAgain) {
        file.readAgain = false
        readCodexRolloutFile(ctx, pane, rollout, file)
      }
      if (current) {
        ctx.publish(paneKey)
      }
    })
    .catch((error: unknown) => {
      batch.release()
      file.reading = false
      console.error('[agent-hooks] Codex rollout read failed:', error)
    })
}

export function readCodexChildName(
  ctx: CodexRolloutReadContext,
  pane: { readonly key: string },
  roster: CodexSubagentRoster,
  id: string,
  filePath: string
): void {
  // A child that finished or moved to another rollout while queued is never read.
  const batch = new RolloutReadBatch(() => roster.get(id)?.identityPath === filePath)
  const { outcome, settled } = scheduleRolloutRead(
    filePath,
    `${pane.key} ${filePath}`,
    batch,
    () => readJsonlFirstRecordAsync(filePath, batch),
    { priority: 1, log: ctx.log }
  )
  void outcome
    .then(async (result) => {
      // A timed-out name read counts as unreadable once its I/O ends, which schedules a later retry.
      const head =
        result.status === 'done'
          ? result.value
          : result.status === 'timedOut'
            ? (await settled, 'unreadable' as const)
            : 'unreadable'
      batch.release()
      // Applied to the roster that asked even if its pane moved; a finished child drops it.
      if (applyCodexSubagentIdentityRead(roster, id, filePath, head, Date.now())) {
        ctx.publish(pane.key)
      }
      // More queued children than one pass reads continue without waiting for a hook.
      ctx.pump(pane.key, false)
    })
    .catch((error: unknown) => {
      batch.release()
      console.error('[agent-hooks] Codex child name read failed:', error)
    })
}
