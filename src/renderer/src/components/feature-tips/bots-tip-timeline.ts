// The bots announcement's pages, each a pure function of `t` (seconds since the page was shown):
// pausing, jumping between pages and reduced motion all read the same frame. The components set
// `data-on` / `data-state` from these cues and CSS transitions carry the motion between frames.

/** Each page's last frame: its animation is over and it holds there before the next page. */
export const BOTS_TIP_PAGE_END = [11.7, 13] as const

export const BOTS_TIP_PAGE_COUNT = BOTS_TIP_PAGE_END.length

/** Seconds a page rests on its last frame before the card moves on. */
export const BOTS_TIP_PAGE_HOLD = 2

/** Shown from `at` until `off`. */
export function cueOn(t: number, at: number, off = Infinity): boolean {
  return t >= at && t < off
}

/** The state of the last step whose time has come; steps are in time order. */
export function cueStep<S>(t: number, steps: readonly (readonly [number, S])[]): S {
  let state = steps[0]![1]
  for (const [at, step] of steps) {
    if (t >= at) {
      state = step
    }
  }
  return state
}

// ----- Page 1: asked in a Slack thread, the bot runs agents, a reviewer bot checks, a PR lands. -----

export const SLACK_PAGE = {
  ask: 0.4,
  typing: [1.5, 2.4],
  reply: 2.4,
  /** Each agent row checks off at its time; the rows fold into one summary row. */
  agentsDone: [4.4, 5, 5.6, 6.2],
  agentsSummary: 7,
  review: 7.6,
  memory: 9.2,
  pullRequest: 10.3
} as const

/** The monkey's paws tap as each Slack message lands. */
export const MASCOT_PAW_TAPS = [0.4, 2.4, 7.6, 9.2, 10.3] as const
const PAW_TAP_SECONDS = 0.22

export function mascotPawTapping(t: number): boolean {
  return MASCOT_PAW_TAPS.some((at) => cueOn(t, at, at + PAW_TAP_SECONDS))
}

// ----- Page 2: a group chat of bots split one goal and come back with one answer. -----

export const GROUP_PAGE = {
  ask: 0.6,
  releaseStarts: 2,
  workerDone: 5.4,
  handOff: 4.2,
  review: 4.8,
  docs: 7.4,
  answer: 10.2
} as const
