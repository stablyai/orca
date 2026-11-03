import { getIntlLocale, translate } from '@/i18n/i18n'

export const CHAT_DEMO_FILE = 'auth.ts'
export const CHAT_DEMO_MODEL = 'Opus'
// Stands in for the file link so translations keep their own word order around it.
const FILE_SLOT = '\u0001'

export type ChatDemoToken = { text: string; link?: true }

export type ChatDemoCopy = {
  tabTitle: string
  prompt: string
  /** The reply in reveal order; whitespace rides on the token before it so the text wraps naturally. */
  reply: ChatDemoToken[]
  flow: { name: string; arrow: string | null }[]
}

export function chatDemoRevealTokens(text: string): ChatDemoToken[] {
  const tokens: ChatDemoToken[] = []
  for (const { segment } of new Intl.Segmenter(getIntlLocale(), { granularity: 'word' }).segment(
    text
  )) {
    const last = tokens.at(-1)
    if (last && !last.link && segment.trim() === '') {
      last.text += segment
    } else {
      tokens.push({ text: segment })
    }
  }
  return tokens
}

export function getChatDemoCopy(): ChatDemoCopy {
  const [before, ...after] = translate(
    'featureTips.chatUiHere.demoReply',
    'Login starts in {{file}}: the browser posts to /login, the server checks the password and creates a session, then redirects you to the app. Here’s the flow:',
    { file: FILE_SLOT }
  ).split(FILE_SLOT)
  return {
    tabTitle: translate('featureTips.chatUiHere.demoTabTitle', 'Explain login'),
    prompt: translate('featureTips.chatUiHere.demoPrompt', 'Map out how login works'),
    reply: [
      ...chatDemoRevealTokens(before),
      ...(after.length > 0
        ? [{ text: CHAT_DEMO_FILE, link: true as const }, ...chatDemoRevealTokens(after.join(''))]
        : [])
    ],
    flow: [
      {
        name: translate('featureTips.chatUiHere.demoBrowser', 'Browser'),
        arrow: translate('featureTips.chatUiHere.demoPassword', 'password')
      },
      { name: '/login', arrow: '' },
      {
        name: translate('featureTips.chatUiHere.demoSession', 'Session'),
        arrow: translate('featureTips.chatUiHere.demoCookie', 'cookie')
      },
      { name: translate('featureTips.chatUiHere.demoApp', 'App'), arrow: null }
    ]
  }
}

/** Milliseconds into the 12.9 s loop at which each beat starts. */
const AT = {
  typeStart: 150,
  typeLength: 1350,
  press: 1720,
  pressLength: 200,
  sent: 1950,
  working: 2600,
  tool: 3400,
  replyStart: 4400,
  replyLength: 1500,
  visual: 6050,
  page: 6400,
  firstNode: 6500,
  nodeStep: 600,
  arrowLag: 300,
  done: 8800,
  fadeOut: 11600,
  empty: 12300,
  loop: 12900
}
const NODE_COUNT = 4

export type ChatDemoSend = 'empty' | 'ready' | 'pressed' | 'stop'

export type ChatDemoFrame = {
  typed: number
  send: ChatDemoSend
  sent: boolean
  working: boolean
  tool: boolean
  words: number
  visual: boolean
  page: boolean
  nodes: number
  arrows: number
  /** The transcript fades as one; its rows keep their finished state until it is transparent. */
  faded: boolean
}

const spread = (count: number, start: number, length: number): number[] =>
  Array.from({ length: count }, (_, index) => start + (index / count) * length)
const countUpTo = (times: readonly number[], at: number): number =>
  times.filter((time) => time <= at).length

export type ChatDemoTimeline = {
  frameAt: (at: number) => ChatDemoFrame
  /** The next moment the frame changes; the loop's end wraps to 0. */
  nextBeat: (at: number) => number
}

/** Typing and streaming pace follow the translated prompt's and reply's lengths. */
export function createChatDemoTimeline(promptLength: number, wordCount: number): ChatDemoTimeline {
  const charTimes = spread(promptLength, AT.typeStart, AT.typeLength)
  const wordTimes = spread(wordCount, AT.replyStart, AT.replyLength)
  const nodeTimes = Array.from({ length: NODE_COUNT }, (_, i) => AT.firstNode + i * AT.nodeStep)
  const arrowTimes = nodeTimes.slice(0, -1).map((time) => time + AT.arrowLag)
  const beats = [
    ...new Set([
      ...charTimes,
      ...wordTimes,
      ...nodeTimes,
      ...arrowTimes,
      AT.press,
      AT.press + AT.pressLength,
      AT.sent,
      AT.working,
      AT.tool,
      AT.replyStart,
      AT.visual,
      AT.page,
      AT.done,
      AT.fadeOut,
      AT.empty,
      AT.loop
    ])
  ].sort((a, b) => a - b)

  return {
    frameAt: (at) => {
      const live = at < AT.empty
      const typing = at >= AT.typeStart && at < AT.sent
      const pressed = at >= AT.press && at < AT.press + AT.pressLength
      return {
        typed: typing ? countUpTo(charTimes, at) : 0,
        send:
          at >= AT.sent && at < AT.done ? 'stop' : pressed ? 'pressed' : typing ? 'ready' : 'empty',
        sent: live && at >= AT.sent,
        working: at >= AT.working && at < AT.replyStart,
        tool: live && at >= AT.tool,
        words: live ? countUpTo(wordTimes, at) : 0,
        visual: live && at >= AT.visual,
        page: live && at >= AT.page,
        nodes: live ? countUpTo(nodeTimes, at) : 0,
        arrows: live ? countUpTo(arrowTimes, at) : 0,
        faded: at >= AT.fadeOut
      }
    },
    nextBeat: (at) => beats.find((beat) => beat > at) ?? AT.loop
  }
}

/** The held, finished frame; also the reduced-motion still. */
export const CHAT_DEMO_FINISHED_AT = AT.done
export const CHAT_DEMO_LOOP_MS = AT.loop
