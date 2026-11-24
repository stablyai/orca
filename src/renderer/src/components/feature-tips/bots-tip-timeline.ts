// The bots announcement's pages, each a pure function of `t` (seconds since the page was shown):
// pausing, jumping between pages and reduced motion all read the same frame. The components set
// `data-on` / `data-state` from these cues and CSS transitions carry the motion between frames.

/** Each page's last frame: its animation is over and it holds there before the next page. */
export const BOTS_TIP_PAGE_END = [11.7, 16.2, 13] as const

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

// ----- Page 2: asked for three things, the bot tracks each as an item and asks on one. -----

export type ItemsCamera = 'full' | 'view'
export type ItemsWorkerBadge = 'run' | 'done'
export type ItemsSubtitle = 'idle' | 'one' | 'two' | 'three' | 'needs'

export const ITEMS_PAGE = {
  ask: 0.6,
  reply: 1.4,
  csvAdded: 2,
  csvWorker: 2.3,
  csvDone: 5.6,
  safariAdded: 2.8,
  safariWorker: 3.1,
  docsAdded: 3.6,
  docsWorker: 3.9,
  docsDone: 7,
  safariAsked: 8.4,
  /** The owner's answer leaves the comment box as their comment on the item. */
  answerSent: 12.9,
  /** The bot reads the answer and moves the item back to In progress. */
  safariResumed: 13.1,
  followUp: 13.4,
  safariDone: 15,
  /** The item view opens from the Needs-you row, and closes back to the list. */
  viewOpen: [9.6, 14.2],
  answerTyping: [11.8, 12.6],
  camera: [
    [0, 'full'],
    [9.7, 'view'],
    [14.2, 'full']
  ] as const satisfies readonly (readonly [number, ItemsCamera])[],
  /** Pointer: clicks the Needs-you row, later the view's Items back link. */
  pointer: [
    [0, 'hide'],
    [9, 'row'],
    [9.4, 'row-press'],
    [9.55, 'row'],
    [10.1, 'hide'],
    [13.7, 'back'],
    [14, 'back-press'],
    [14.15, 'back'],
    [14.7, 'hide']
  ] as const
} as const

export type ItemsPointer = (typeof ITEMS_PAGE.pointer)[number][1]

/** Worker badges: csv and docs finish; safari waits on the question, then resumes and finishes. */
export function itemsWorkerBadge(
  t: number,
  worker: 'csv' | 'safari' | 'docs' | 'follow-up'
): ItemsWorkerBadge {
  const doneAt = {
    csv: 5.3,
    docs: 6.7,
    safari: 14.7,
    'follow-up': 14.7
  }[worker]
  return t >= doneAt ? 'done' : 'run'
}

export function itemsSubtitle(t: number): ItemsSubtitle {
  return cueStep<ItemsSubtitle>(t, [
    [0, 'idle'],
    [2, 'one'],
    [2.8, 'two'],
    [3.6, 'three'],
    [5.6, 'two'],
    [7, 'one'],
    [8.4, 'needs'],
    [13.1, 'one'],
    [15, 'idle']
  ])
}

/** How many items each group of the Items list holds at `t`. */
export function itemsGroupCounts(t: number): {
  needsYou: number
  inProgress: number
  closed: number
} {
  const p = ITEMS_PAGE
  const needsYou = cueOn(t, p.safariAsked, p.safariResumed) ? 1 : 0
  const inProgress =
    (cueOn(t, p.csvAdded, p.csvDone) ? 1 : 0) +
    (cueOn(t, p.safariAdded, p.safariAsked) || cueOn(t, p.safariResumed, p.safariDone) ? 1 : 0) +
    (cueOn(t, p.docsAdded, p.docsDone) ? 1 : 0)
  const closed = (t >= p.csvDone ? 1 : 0) + (t >= p.docsDone ? 1 : 0) + (t >= p.safariDone ? 1 : 0)
  return { needsYou, inProgress, closed }
}

// ----- Page 3: a group chat of bots split one goal and come back with one answer. -----

export const GROUP_PAGE = {
  ask: 0.6,
  releaseStarts: 2,
  workerDone: 5.4,
  handOff: 4.2,
  review: 4.8,
  docs: 7.4,
  answer: 10.2
} as const
