import { createElement, Fragment, type ReactNode } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { RestartMachineKey } from './native-chat-restart-machines'

/**
 * The one toast a resume raises, clicked or automatic: what it did across chats that are mostly
 * off-screen, on every machine it reached. Each chat's own note stays the record of what happened
 * to it.
 */

/** One `continued` row as the host reports it. */
export type RestartContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
}

/** How one machine's part of a resume ended: the host's answer (or, when the request was lost, the
 *  list re-read after it), a paired request whose answer and re-read were both lost, or a request
 *  refused before it was sent (the server was re-paired). */
export type RestartContinueResult = {
  machine: RestartMachineKey
  /** Names a paired server; this computer's own chats need no "where". */
  machineName?: string
  requested: readonly string[]
} & (
  | {
      kind: 'answered'
      /** Undefined for an answer without outcomes, which may still have sent the message. */
      results: readonly RestartContinuationOutcome[] | undefined
      /** The failure list after the action, as the dialog shows it; undefined when none was read. */
      hostFailed: readonly Pick<ResumeFailure, 'sessionId' | 'outcome'>[] | undefined
    }
  | {
      kind: 'unconfirmed'
      /** Whether the machine still has a listing for Show to open. */
      listed: boolean
    }
  | { kind: 'not-sent' }
)

/** `machineName` names a paired server; this computer's own chats need no "where". */
function continuedText(count: number, machineName: string | undefined): string {
  if (machineName !== undefined) {
    return count === 1
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.continuedOneOnMachine',
          'Resumed 1 chat on {{value0}}',
          { value0: machineName }
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.continuedManyOnMachine',
          'Resumed {{value0}} chats on {{value1}}',
          { value0: count, value1: machineName }
        )
  }
  return count === 1
    ? translate('auto.components.NativeChatResumeOnRestartModal.continuedOne', 'Resumed 1 chat')
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.continuedMany',
        'Resumed {{value0}} chats',
        { value0: count }
      )
}

function refusedCountText(count: number, machineName: string | undefined): string {
  if (machineName !== undefined) {
    return count === 1
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.notContinuedOneOnMachine',
          '1 chat on {{value0}} couldn’t be resumed',
          { value0: machineName }
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.notContinuedManyOnMachine',
          '{{value0}} chats on {{value1}} couldn’t be resumed',
          { value0: count, value1: machineName }
        )
  }
  return count === 1
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.notContinuedOne',
        '1 chat couldn’t be resumed'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.notContinuedMany',
        '{{value0}} chats couldn’t be resumed',
        { value0: count }
      )
}

function unconfirmedCountText(count: number, machineName: string | undefined): string {
  if (machineName !== undefined) {
    return count === 1
      ? translate(
          'auto.components.NativeChatResumeOnRestartModal.notConfirmedOneOnMachine',
          'Couldn’t confirm 1 chat on {{value0}} was resumed',
          { value0: machineName }
        )
      : translate(
          'auto.components.NativeChatResumeOnRestartModal.notConfirmedManyOnMachine',
          'Couldn’t confirm {{value0}} chats on {{value1}} were resumed',
          { value0: count, value1: machineName }
        )
  }
  return count === 1
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedOne',
        'Couldn’t confirm 1 chat was resumed'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedMany',
        'Couldn’t confirm {{value0}} chats were resumed',
        { value0: count }
      )
}

/** Beneath a refused count, so it cannot read as the same chat restated. */
function otherUnconfirmedCountText(count: number): string {
  return count === 1
    ? translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedOtherOne',
        'Couldn’t confirm 1 other chat was resumed'
      )
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.notConfirmedOtherMany',
        'Couldn’t confirm {{value0}} other chats were resumed',
        { value0: count }
      )
}

/** A string description renders inline, so a second line needs its own block. */
function descriptionFrom(lines: readonly string[]): ReactNode {
  return lines.length === 1
    ? lines[0]
    : createElement(
        Fragment,
        null,
        ...lines.map((line) => createElement('span', { key: line, className: 'block' }, line))
      )
}

/** Which of the requested chats the host did not carry on: refused, unconfirmed, or — since
 *  eligibility can change after listing — omitted from the answer altogether. */
export function restartChatsNotContinued(
  requested: readonly string[],
  results: readonly RestartContinuationOutcome[]
): string[] {
  const bySession = new Map(results.map((result) => [result.sessionId, result.outcome]))
  return [...new Set(requested)].filter((sessionId) => bySession.get(sessionId) !== 'continued')
}

/** Reconcile once with the action's confirmed list; later dismissals are not successes. */
export function restartContinuationHistory(
  requested: readonly string[],
  reported: readonly RestartContinuationOutcome[] | undefined,
  failed: readonly Pick<ResumeFailure, 'sessionId'>[] | undefined
): readonly RestartContinuationOutcome[] {
  const results = Array.isArray(reported)
    ? reported
    : requested.map((sessionId) => ({ sessionId, outcome: 'unknown' as const }))
  const failedIds = new Set(failed?.map((entry) => entry.sessionId))
  return results.map((entry) =>
    failed !== undefined &&
    !failedIds.has(entry.sessionId) &&
    (entry.outcome === 'unknown' || entry.outcome === 'pending')
      ? { ...entry, outcome: 'continued' as const }
      : entry
  )
}

type MachineTally = {
  machine: RestartMachineKey
  machineName: string | undefined
  continued: number
  refused: number
  unconfirmed: number
  /** Whether a failure list was read, so Show has rows to open. */
  listed: boolean
}

function tallyAnswer(
  requested: readonly string[],
  reportedResults: readonly RestartContinuationOutcome[] | undefined,
  hostFailed: readonly Pick<ResumeFailure, 'sessionId' | 'outcome'>[] | undefined
): Omit<MachineTally, 'machine' | 'machineName'> {
  const results = restartContinuationHistory(requested, reportedResults, hostFailed)
  const notContinued = restartChatsNotContinued(requested, results)
  const failed = new Map(hostFailed?.map((failure) => [failure.sessionId, failure.outcome]))
  // A host that lists failures has already dropped chats that moved on by themselves or that the
  // user answered; counting those would report a failure nothing on screen can show.
  const reported =
    hostFailed === undefined
      ? notContinued
      : notContinued.filter((sessionId) => failed.has(sessionId))
  const outcomes = new Map(results.map((result) => [result.sessionId, result.outcome]))
  const sentUnconfirmed = (sessionId: string): boolean =>
    outcomes.get(sessionId) === 'pending' || outcomes.get(sessionId) === 'unknown'
  // The filed outcome is what the list shows, so the toast uses it too.
  const unconfirmed = (sessionId: string): boolean =>
    (failed.get(sessionId) ?? (sentUnconfirmed(sessionId) ? 'unconfirmed' : 'refused')) ===
    'unconfirmed'
  const unconfirmedCount = reported.filter(unconfirmed).length
  return {
    continued: new Set(requested).size - notContinued.length,
    refused: reported.length - unconfirmedCount,
    unconfirmed: unconfirmedCount,
    listed: hostFailed !== undefined
  }
}

function tally(result: RestartContinueResult): MachineTally {
  const base = { machine: result.machine, machineName: result.machineName }
  if (result.kind === 'unconfirmed') {
    const unconfirmed = new Set(result.requested).size
    return { ...base, continued: 0, refused: 0, unconfirmed, listed: result.listed }
  }
  if (result.kind === 'not-sent') {
    // Nothing reached the host and the pairing it was listed under is gone: no list to show.
    const refused = new Set(result.requested).size
    return { ...base, continued: 0, refused, unconfirmed: 0, listed: false }
  }
  return { ...base, ...tallyAnswer(result.requested, result.results, result.hostFailed) }
}

/** One machine's name when it alone holds the counted chats; otherwise the count needs no "where"
 *  and the dialog it opens lists each machine. */
function soleMachineName(tallies: readonly MachineTally[]): string | undefined {
  return tallies.length === 1 ? tallies[0]!.machineName : undefined
}

function sum(tallies: readonly MachineTally[], count: (entry: MachineTally) => number): number {
  return tallies.reduce((total, entry) => total + count(entry), 0)
}

/**
 * One toast per resume, however many machines it reached: what went wrong leads, and the rest of
 * the outcome rides beneath it. No chat names: the dialog behind Show has the list. Unconfirmed
 * chats get their own count because the agent may well be working; "couldn't be resumed" would
 * invite a second send. Show opens the run's summary, so it is offered whenever there is a result
 * to look at: a chat resumed, or a failure list read.
 *
 * `show` opens the dialog over a fresh read, on the one machine it concerns or on none in particular.
 */
export function announceRestartResults(
  results: readonly RestartContinueResult[],
  show: (machine: RestartMachineKey | null) => void
): void {
  const tallies = results.map(tally)
  const failing = tallies.filter((entry) => entry.refused + entry.unconfirmed > 0)
  const continuing = tallies.filter((entry) => entry.continued > 0)
  const refused = sum(failing, (entry) => entry.refused)
  const unconfirmed = sum(failing, (entry) => entry.unconfirmed)
  const continued = sum(continuing, (entry) => entry.continued)
  const showable = tallies.filter((entry) => entry.listed || entry.continued > 0)
  const action =
    showable.length === 0
      ? {}
      : {
          action: {
            label: translate('auto.components.NativeChatResumeOnRestartModal.show', 'Show'),
            onClick: () => show(showable.length === 1 ? showable[0]!.machine : null)
          }
        }
  if (failing.length === 0) {
    if (continued > 0) {
      toast(continuedText(continued, soleMachineName(continuing)), action)
    }
    return
  }
  const title =
    refused > 0
      ? refusedCountText(refused, soleMachineName(failing))
      : unconfirmedCountText(unconfirmed, soleMachineName(failing))
  const lines = [
    ...(refused > 0 && unconfirmed > 0 ? [otherUnconfirmedCountText(unconfirmed)] : []),
    ...(continued > 0 ? [continuedText(continued, soleMachineName(continuing))] : [])
  ]
  toast(title, {
    ...(lines.length === 0 ? {} : { description: descriptionFrom(lines) }),
    ...action
  })
}
