import { beforeEach, describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import {
  teamDeleteBlockerLines,
  teamDeleteCancelsPlanText,
  teamDeleteFailure
} from './team-delete-copy'
import {
  resetTeamDeletePlanEndedForTests,
  teamDeleteCheckFrom,
  teamDeleteFailureAfterCancel
} from './use-team-delete'

// Mirrors i18next's `_one` plural pick so both forms are checked.
const t: Translate = (_key, fallback, options) => {
  const one = options?.count === 1 ? options.defaultValue_one : undefined
  const text = typeof one === 'string' ? one : fallback
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))
}

describe('TEAM-DELETE copy', () => {
  it('names each blocker with its way out, plan first', () => {
    const lines = teamDeleteBlockerLines(
      [
        { code: 'workspaces_exist', count: 3 },
        { code: 'subscription_active', status: 'past_due' }
      ],
      t
    )
    expect(lines.map((line) => [line.text, line.actionLabel])).toEqual([
      [
        'Your team still has a plan. Cancel it in billing first, then delete the team.',
        'Manage billing'
      ],
      ['3 cloud workspaces still exist. Delete them first.', 'Show cloud workspaces']
    ])
    expect(teamDeleteBlockerLines([{ code: 'workspaces_exist', count: 1 }], t)[0]?.text).toBe(
      '1 cloud workspace still exists. Delete it first.'
    )
  })

  it('keeps every failure in the dialog with its reason', () => {
    expect(teamDeleteFailure({ status: 'deleted' }, t)).toBeNull()
    expect(teamDeleteFailure({ status: 'confirm-mismatch' }, t)).toEqual({
      kind: 'mismatch',
      text: 'The team name doesn’t match.'
    })
    expect(teamDeleteFailure({ status: 'unavailable' }, t)).toEqual({
      kind: 'message',
      text: 'Couldn’t check the team right now, so nothing was deleted. Try again.'
    })
    expect(teamDeleteFailure({ status: 'rate-limited' }, t)).toEqual({
      kind: 'message',
      text: 'Too many attempts. Wait a minute, then try again.'
    })
    const blockers = [{ code: 'workspaces_exist' as const, count: 2 }]
    expect(teamDeleteFailure({ status: 'blocked', blockers }, t)).toEqual({
      kind: 'blocked',
      blockers
    })
  })

  it('pre-check: hides the card when auth has no route or says not an owner', () => {
    expect(teamDeleteCheckFrom({ status: 'unsupported' })).toBeNull()
    expect(teamDeleteCheckFrom({ status: 'forbidden' })).toBeNull()
    // A failed check still offers the delete; auth checks again at submit.
    expect(teamDeleteCheckFrom({ status: 'unavailable' })).toEqual({ state: 'ready', blockers: [] })
    expect(
      teamDeleteCheckFrom({
        status: 'ok',
        deletable: false,
        blockers: [{ code: 'subscription_active', status: 'active' }]
      })
    ).toEqual({ state: 'ready', blockers: [{ code: 'subscription_active', status: 'active' }] })
  })
})

describe('EP-10: deleting a team whose plan is set to end', () => {
  beforeEach(resetTeamDeletePlanEndedForTests)

  it('the check carries the plan end, and the dialog says the delete ends it now', () => {
    expect(
      teamDeleteCheckFrom({
        status: 'ok',
        deletable: true,
        blockers: [],
        cancelsSubscription: { periodEnd: '2026-12-01T12:00:00.000Z' }
      })
    ).toEqual({
      state: 'ready',
      blockers: [],
      cancelsSubscription: { periodEnd: '2026-12-01T12:00:00.000Z' }
    })
    expect(teamDeleteCancelsPlanText('2026-12-01T12:00:00.000Z', t, 'en-US')).toBe(
      'Your plan is set to end on December 1, 2026. Deleting the team ends it now, with no refund for the rest of the period.'
    )
  })

  it('a delete that failed after the plan ended says so, and so does every later failure', () => {
    const afterCancel = {
      status: 'failed-after-cancel' as const,
      cause: 'sandbox_control_unavailable'
    }
    const first = teamDeleteFailureAfterCancel(
      'org_1',
      afterCancel,
      teamDeleteFailure(afterCancel, t),
      t
    )
    expect(first?.kind).toBe('planEnded')
    // The retry fails with an ordinary code; the plan is still gone, so the words stay.
    const retry = { status: 'unavailable' as const }
    expect(teamDeleteFailureAfterCancel('org_1', retry, teamDeleteFailure(retry, t), t)).toEqual({
      kind: 'planEnded',
      text: 'Your team wasn’t deleted, but its plan has already ended, with no refund for the rest of the period.'
    })
    // A mistyped name is still just a mistyped name; another team is unaffected.
    const mismatch = { status: 'confirm-mismatch' as const }
    expect(
      teamDeleteFailureAfterCancel('org_1', mismatch, teamDeleteFailure(mismatch, t), t)?.kind
    ).toBe('mismatch')
    expect(teamDeleteFailureAfterCancel('org_2', retry, teamDeleteFailure(retry, t), t)?.kind).toBe(
      'message'
    )
  })
})
