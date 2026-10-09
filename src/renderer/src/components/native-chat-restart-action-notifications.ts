import { createElement, Fragment, type ReactNode } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ResumeFailure } from './native-chat-resume-on-restart-grouping'

/**
 * The one toast a resume raises, clicked or automatic at launch: what it did across chats that are
 * mostly off-screen. Each chat's own note stays the record of what happened to it.
 */

/** One `continued` row as the host reports it. */
export type RestartContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
}

function continuedCountText(count: number): string {
  return count === 1
    ? translate('auto.components.NativeChatResumeOnRestartModal.continuedOne', 'Resumed 1 chat')
    : translate(
        'auto.components.NativeChatResumeOnRestartModal.continuedMany',
        'Resumed {{value0}} chats',
        { value0: count }
      )
}

function refusedCountText(count: number): string {
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

function unconfirmedCountText(count: number): string {
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

/** One toast per resume; Show opens the run summary. Unconfirmed chats may already be working. */
function announceResume(
  continued: number,
  refused: number,
  unconfirmed: number,
  show: (() => Promise<void>) | undefined
): void {
  const action =
    show === undefined
      ? {}
      : {
          action: {
            label: translate('auto.components.NativeChatResumeOnRestartModal.show', 'Show'),
            onClick: () => void show()
          }
        }
  if (refused === 0 && unconfirmed === 0) {
    if (continued > 0) {
      toast(continuedCountText(continued), action)
    }
    return
  }
  const title = refused > 0 ? refusedCountText(refused) : unconfirmedCountText(unconfirmed)
  const lines = [
    ...(refused > 0 && unconfirmed > 0 ? [otherUnconfirmedCountText(unconfirmed)] : []),
    ...(continued > 0 ? [continuedCountText(continued)] : [])
  ]
  toast(title, {
    ...(lines.length === 0 ? {} : { description: descriptionFrom(lines) }),
    ...action
  })
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

export function announceRestartResults(
  requested: readonly string[],
  /** Undefined for an answer without outcomes, which may still have sent the message. */
  reportedResults: readonly RestartContinuationOutcome[] | undefined,
  /** The failure list after the action, as the dialog shows it; undefined when none was read. */
  hostFailed: readonly Pick<ResumeFailure, 'sessionId' | 'outcome'>[] | undefined,
  /** Opens the dialog over a fresh read; never rejects. */
  show: () => Promise<void>
): void {
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
  const continuedCount = new Set(requested).size - notContinued.length
  announceResume(
    continuedCount,
    reported.length - unconfirmedCount,
    unconfirmedCount,
    hostFailed === undefined && continuedCount === 0 ? undefined : show
  )
}
