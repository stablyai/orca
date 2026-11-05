import { expect, it } from 'vitest'
import {
  acceptPRCheckObservation,
  isCompletePRCheckOwner,
  projectPRCheckOwner
} from './complete-pr-check-owner'

const summary = {
  state: 'success' as const,
  total: 101,
  passed: 101,
  failed: 0,
  pending: 0,
  neutral: 0
}
const pr = {
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  headSha: 'h1',
  checksStatus: 'success' as const,
  checksSummary: summary
}
const context = { scope: 'account:runtime1', complete: true, current: true }

it('retains last-good only for the same proved source, target and nonempty head', () => {
  const accepted = acceptPRCheckObservation(pr, null, context)!
  expect(
    acceptPRCheckObservation({ ...pr, checksSummary: undefined }, accepted, context)?.checksSummary
  ).toEqual(summary)
  for (const next of [
    { ...pr, headSha: 'h2' },
    { ...pr, headSha: '' },
    { ...pr, number: 43, url: 'https://github.com/acme/widgets/pull/43' },
    { ...pr, url: 'https://github.com/other/widgets/pull/42' }
  ]) {
    expect(
      acceptPRCheckObservation({ ...next, checksSummary: undefined }, accepted, context)
        ?.checksSummary
    ).toBeUndefined()
  }
  expect(
    acceptPRCheckObservation({ ...pr, checksSummary: undefined }, accepted, {
      ...context,
      scope: 'account:runtime2'
    })?.checksSummary
  ).toBeUndefined()
  expect(acceptPRCheckObservation(pr, accepted, { ...context, current: false })).toBeNull()
  expect(
    acceptPRCheckObservation({ ...pr, checksSummary: undefined }, pr, context)?.checksSummary
  ).toBeUndefined()
})

it('carries unavailable authority explicitly through display and review projections without lending it to another head', () => {
  const unavailable = acceptPRCheckObservation({ ...pr, checksSummary: undefined }, null, context)!
  const display = projectPRCheckOwner(unavailable, { ...unavailable })
  expect(isCompletePRCheckOwner(display)).toBe(true)
  const review = projectPRCheckOwner(display, { ...display, status: display.checksStatus })
  expect(isCompletePRCheckOwner(review)).toBe(true)
  expect(isCompletePRCheckOwner({ ...review })).toBe(false)
  expect(isCompletePRCheckOwner(projectPRCheckOwner(review, { ...review, headSha: 'h2' }))).toBe(
    false
  )
  const full = acceptPRCheckObservation(pr, null, context)!
  expect(isCompletePRCheckOwner({ ...pr, checksSummary: full.checksSummary })).toBe(false)
})
