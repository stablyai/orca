import { expect, it } from 'vitest'
import { acceptPRCheckObservation } from './complete-pr-check-owner'

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
