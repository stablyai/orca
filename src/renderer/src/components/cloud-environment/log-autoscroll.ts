/** Within this many px of the bottom counts as "at the bottom" (sub-pixel rounding, momentum). */
export const STICKY_THRESHOLD_PX = 24

export type AutoscrollState = {
  following: boolean
  /** Lines appended while the user was reading history; drives the "Jump to latest" pill. */
  unseen: number
  lastScrollTop: number
  /** The viewport is scrolled away from the end (the pill only makes sense then). */
  awayFromBottom: boolean
}

export type AutoscrollAction =
  | {
      type: 'scroll'
      scrollTop: number
      scrollHeight: number
      clientHeight: number
    }
  | { type: 'append'; count: number }
  | { type: 'jump' }
  /** Stop following without a user scroll (e.g. we scrolled to a failure). */
  | { type: 'release' }
  | { type: 'reset' }

export const initialAutoscrollState: AutoscrollState = {
  following: true,
  unseen: 0,
  lastScrollTop: 0,
  awayFromBottom: false
}

/**
 * Stick to the bottom while following; only an upward scroll unsticks (content growth moves
 * scrollHeight, not scrollTop, so a burst of output can never look like the user scrolling away).
 */
export function autoscrollReducer(
  state: AutoscrollState,
  action: AutoscrollAction
): AutoscrollState {
  switch (action.type) {
    case 'scroll': {
      const distance = action.scrollHeight - action.clientHeight - action.scrollTop
      if (distance <= STICKY_THRESHOLD_PX) {
        return {
          following: true,
          unseen: 0,
          lastScrollTop: action.scrollTop,
          awayFromBottom: false
        }
      }
      const movedUp = action.scrollTop < state.lastScrollTop - 1
      return {
        following: movedUp ? false : state.following,
        unseen: state.unseen,
        lastScrollTop: action.scrollTop,
        awayFromBottom: true
      }
    }
    case 'append':
      if (state.following || action.count <= 0) {
        return state
      }
      return { ...state, unseen: state.unseen + action.count }
    case 'jump':
      return { ...state, following: true, unseen: 0, awayFromBottom: false }
    case 'release':
      return state.following ? { ...state, following: false } : state
    case 'reset':
      return initialAutoscrollState
  }
}
