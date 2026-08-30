import { describe, expect, it } from 'vitest'
import { readWindowCloseRequestPayload } from './window-close-request'

/**
 * The reader is the last place an undetermined answer can be turned into a
 * confident one. Everything downstream treats `localPtysSurviveQuit: true` as
 * permission to close over running work with no warning, so anything that is not
 * an explicit `true` must come out `false`.
 */
describe('readWindowCloseRequestPayload', () => {
  it('carries an explicit survival yes through', () => {
    expect(
      readWindowCloseRequestPayload({ isQuitting: true, localPtysSurviveQuit: true, requestId: 7 })
    ).toEqual({ isQuitting: true, localPtysSurviveQuit: true, requestId: 7 })
  })

  it('reads a missing survival field as "does not survive", not as silence to spend', () => {
    expect(readWindowCloseRequestPayload({ isQuitting: true }).localPtysSurviveQuit).toBe(false)
  })

  it.each([
    ['a truthy string', 'yes'],
    ['a truthy number', 1],
    ['null', null],
    ['undefined', undefined]
  ])('reads %s as "does not survive"', (_label, value) => {
    expect(
      readWindowCloseRequestPayload({ isQuitting: true, localPtysSurviveQuit: value })
        .localPtysSurviveQuit
    ).toBe(false)
  })

  /** The other half of the same decision. `isQuitting` is not only the survival
   *  answer's partner in the bypass: it alone drops SSH-backed panes from the
   *  evidence, so a truthy non-boolean read as a yes closes over remote work the
   *  warning would have shown. Pinned to the same strictness as its sibling. */
  it.each([
    ['a truthy string', 'yes'],
    ['a truthy number', 1],
    ['null', null],
    ['undefined', undefined]
  ])('reads %s as "not quitting"', (_label, value) => {
    expect(readWindowCloseRequestPayload({ isQuitting: value }).isQuitting).toBe(false)
  })

  it('survives a payload that is not an object at all', () => {
    expect(readWindowCloseRequestPayload(undefined)).toEqual({
      isQuitting: false,
      localPtysSurviveQuit: false,
      requestId: undefined
    })
  })

  it('drops a non-numeric requestId rather than echoing it back as an ack', () => {
    expect(
      readWindowCloseRequestPayload({ isQuitting: true, requestId: '3' }).requestId
    ).toBeUndefined()
  })
})
