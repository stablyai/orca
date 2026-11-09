import { describe, expect, it } from 'vitest'
import { autoscrollReducer, initialAutoscrollState } from './log-autoscroll'

const scroll = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) =>
  ({ type: 'scroll', scrollTop, scrollHeight, clientHeight }) as const

describe('autoscrollReducer', () => {
  it('keeps following while content grows under a pinned viewport', () => {
    let state = autoscrollReducer(initialAutoscrollState, scroll(1500))
    // Output arrived: scrollHeight grew, scrollTop did not move (no programmatic scroll yet).
    state = autoscrollReducer(state, scroll(1500, 4000))
    expect(state.following).toBe(true)
  })

  it('unsticks when the user scrolls up and counts unseen lines', () => {
    let state = autoscrollReducer(initialAutoscrollState, scroll(1500))
    state = autoscrollReducer(state, scroll(1200))
    expect(state).toMatchObject({ following: false, awayFromBottom: true })
    state = autoscrollReducer(state, { type: 'append', count: 5 })
    state = autoscrollReducer(state, { type: 'append', count: 3 })
    expect(state.unseen).toBe(8)
  })

  it('re-sticks when the user returns to the bottom', () => {
    let state = autoscrollReducer(initialAutoscrollState, scroll(1500))
    state = autoscrollReducer(state, scroll(1000))
    state = autoscrollReducer(state, scroll(1490))
    expect(state).toMatchObject({ following: true, unseen: 0 })
  })

  it('jump re-follows and clears the pill', () => {
    let state = autoscrollReducer(initialAutoscrollState, scroll(1500))
    state = autoscrollReducer(state, scroll(100))
    state = autoscrollReducer(state, { type: 'append', count: 2 })
    state = autoscrollReducer(state, { type: 'jump' })
    expect(state).toMatchObject({ following: true, unseen: 0 })
  })

  it('does not count appends while following', () => {
    const state = autoscrollReducer(initialAutoscrollState, {
      type: 'append',
      count: 10
    })
    expect(state.unseen).toBe(0)
  })
})
