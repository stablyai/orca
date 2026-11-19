import { chatDemoRevealTokens } from './chat-ui-here-feature-tip-demo'

const AT = { keys: 800, press: 1060, listen: 1220, firstPhrase: 1720 }
// The pill mounts once its slot above the composer has grown, so it never slides in over the composer.
export const DICTATION_DEMO_SLOT_GROW_MS = 180
const PILL_AT = AT.listen + DICTATION_DEMO_SLOT_GROW_MS
const WORD_MS = 380
// The pause that commits the first phrase into the composer.
const COMMIT_PAUSE_MS = 500
const END_HOLD_MS = 3000
// Grape sizes per spoken word, so the meter moves with the voice and rests in pauses.
const WORD_LEVELS = [0.55, 0.8, 0.45, 0.7, 0.9, 0.5, 0.75, 0.6, 0.85]

export const DICTATION_DEMO_PLAYS = 2

export type DictationDemoFrame = {
  keys: 'hidden' | 'shown' | 'pressed'
  /** The pill's slot above the composer is open. */
  listening: boolean
  pill: boolean
  /** What the pill has heard of the phrase it is on. */
  heard: string
  /** What dictation has committed into the composer. */
  draft: string
  seconds: number
  level: number
}

export type DictationDemoTimeline = {
  frameAt: (at: number) => DictationDemoFrame
  /** The next moment the frame changes; the loop's end wraps to 0. */
  nextBeat: (at: number) => number
  /** The held last frame; also the reduced-motion still. */
  endAt: number
  loopAt: number
}

/** Spoken words, each carrying its trailing space and punctuation, so one lands per beat. */
function spokenWords(text: string, intlLocale?: string): string[] {
  const words: string[] = []
  for (const { text: token } of chatDemoRevealTokens(text, intlLocale)) {
    if (words.length > 0 && !/[\p{L}\p{N}]/u.test(token)) {
      words[words.length - 1] += token
    } else {
      words.push(token)
    }
  }
  return words
}

const countUpTo = (times: readonly number[], at: number): number =>
  times.filter((time) => time <= at).length

export function createDictationDemoTimeline(
  firstPhrase: string,
  secondPhrase: string,
  intlLocale?: string
): DictationDemoTimeline {
  const first = spokenWords(firstPhrase, intlLocale)
  const second = spokenWords(secondPhrase, intlLocale)
  const firstTimes = first.map((_, index) => AT.firstPhrase + index * WORD_MS)
  const commitAt = AT.firstPhrase + first.length * WORD_MS + COMMIT_PAUSE_MS
  const secondTimes = second.map((_, index) => commitAt + (index + 1) * WORD_MS)
  const wordTimes = [...firstTimes, ...secondTimes]
  const endAt = (secondTimes.at(-1) ?? commitAt) + WORD_MS
  const loopAt = endAt + END_HOLD_MS
  const secondTicks = Array.from(
    { length: Math.floor((endAt - AT.listen) / 1000) },
    (_, index) => AT.listen + (index + 1) * 1000
  )
  const beats = [
    ...new Set([
      AT.keys,
      AT.press,
      AT.listen,
      PILL_AT,
      commitAt,
      endAt,
      loopAt,
      ...wordTimes,
      ...wordTimes.map((time) => time + WORD_MS),
      ...secondTicks
    ])
  ].sort((a, b) => a - b)

  const heardOf = (words: string[], times: number[], at: number): string =>
    words.slice(0, countUpTo(times, at)).join('').trim()

  return {
    frameAt: (at) => {
      const speaking = wordTimes.findLastIndex((time) => time <= at && at < time + WORD_MS)
      return {
        keys: at < AT.keys || at >= AT.listen ? 'hidden' : at >= AT.press ? 'pressed' : 'shown',
        listening: at >= AT.listen,
        pill: at >= PILL_AT,
        heard: at < commitAt ? heardOf(first, firstTimes, at) : heardOf(second, secondTimes, at),
        draft: at < commitAt ? '' : first.join('').trim(),
        seconds: at >= AT.listen ? Math.floor((at - AT.listen) / 1000) : 0,
        level: speaking === -1 ? 0 : WORD_LEVELS[speaking % WORD_LEVELS.length]
      }
    },
    nextBeat: (at) => beats.find((beat) => beat > at) ?? loopAt,
    endAt,
    loopAt
  }
}
