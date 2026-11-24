import { setRendererUiLanguage, translate } from '@/i18n/i18n'
import { TranslationScopeContext, type Translate } from '@/i18n/use-translate'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import type { ResumeRun } from '../runs/native-chat-resume-run'
import { resumeToastView } from './native-chat-resume-toast-view'
import { NativeChatResumeToast } from './NativeChatResumeToast'

const NOW = 1_800_000_000_000
const noop = (): void => {}
const actions = {
  onResume: noop,
  onRowAction: noop,
  onOpenSettings: noop,
  onClose: noop,
  nameFor: (_sessionId: string, fallback: string) => fallback
}

const PROMPTS = [
  'Refactor the settings sidebar so long section names wrap instead of clipping at narrow widths',
  'Fix the flaky Windows path test',
  'Tighten onboarding copy',
  'Add retry with backoff to the sync client and cover the offline case with an integration test',
  'Investigate memory growth in the terminal renderer after long sessions',
  'Write release notes',
  'Migrate the export job to the new queue',
  'Audit focus order in the command palette',
  'Draft the weekly status update',
  'Port the theme tokens to the mobile app',
  'Trim unused dependencies',
  'Profile startup on a cold cache'
]

function chat(index: number, trigger: ResumeCandidate['trigger'] = 'update'): ResumeCandidate {
  return {
    sessionId: `chat-${index}`,
    workspaceId: 'demo-workspace',
    agent: index % 2 === 0 ? 'claude' : 'codex',
    trigger,
    latestPrompt: PROMPTS[index % PROMPTS.length] ?? 'Untitled',
    recordedAt: NOW - (index + 1) * 7 * 60_000
  }
}

const twelve = PROMPTS.map((_, index) => chat(index))
const notAttached: ResumeFailure = {
  ...chat(0),
  failedAt: NOW,
  outcome: 'refused',
  reason: 'agent_session_not_attached',
  retryable: true
}

function finishedRun(
  chats: readonly ResumeCandidate[],
  startedBy: ResumeRun['startedBy']
): ResumeRun {
  return {
    startedAt: NOW,
    startedBy,
    entries: chats.map((candidate) => ({ candidate })),
    inFlight: false,
    continued: chats.map((candidate) => ({ sessionId: candidate.sessionId, outcome: 'continued' }))
  }
}

const NARROW = 360
/** The toaster's narrowest width, min(26rem, 100vw - 2rem) = 328 px in a 360 px window, plus the frame's padding. */
const NARROWEST = 360

export const offerManual = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(null, twelve.slice(0, 3), new Map())}
      listedAt={NOW}
      onDismissAll={noop}
      {...actions}
    />
  )
})

export const offerManualDetails = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(null, twelve.slice(0, 3), new Map())}
      listedAt={NOW}
      onDismissAll={noop}
      defaultExpanded
      {...actions}
    />
  )
})

export const resuming = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(
        { ...finishedRun(twelve.slice(0, 3), 'launch'), inFlight: true, continued: undefined },
        twelve.slice(0, 3),
        new Map()
      )}
      listedAt={NOW}
      {...actions}
    />
  )
})

export const allResumed = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(finishedRun(twelve.slice(0, 3), 'launch'), [], new Map())}
      listedAt={NOW}
      {...actions}
    />
  )
})

/** Worst case: twelve chats with long names, one needing the person, Details open. */
export const twelveOneNeedsYou = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(
        finishedRun(twelve, 'launch'),
        [],
        new Map([[notAttached.sessionId, notAttached]])
      )}
      listedAt={NOW}
      defaultExpanded
      {...actions}
    />
  )
})

export const twelveOneNeedsYouCollapsed = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(
        finishedRun(twelve, 'launch'),
        [],
        new Map([[notAttached.sessionId, notAttached]])
      )}
      listedAt={NOW}
      {...actions}
    />
  )
})

export const remoteServer = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(null, [chat(1, 'quit'), chat(2, 'quit')], new Map())}
      machineName="build-server-02"
      listedAt={NOW}
      {...actions}
    />
  )
})

/** A bot's chats lead with its name; its own chat is always "Home". */
const BOT_CHATS: Record<string, { bot: string; chat: string }> = {
  'chat-0': { bot: 'UX Designer', chat: 'Home' },
  'chat-1': { bot: 'UX Designer', chat: 'Review the onboarding flow' }
}

function botChats(chats: Record<string, { bot: string; chat: string }>) {
  return {
    nameFor: (sessionId: string, fallback: string) => chats[sessionId]?.chat ?? fallback,
    botNameFor: (candidate: ResumeCandidate) => chats[candidate.sessionId]?.bot
  }
}

export const botChatsResumed = defineFixture({
  width: NARROW,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(finishedRun(twelve.slice(0, 3), 'launch'), [], new Map())}
      listedAt={NOW}
      defaultExpanded
      {...actions}
      {...botChats(BOT_CHATS)}
    />
  )
})

const LONG_BOT = 'Customer Onboarding Research Assistant'
const LONG_NAME_CHATS = {
  'chat-0': {
    bot: `${LONG_BOT} 01`,
    chat: 'Summarize every interview from last week and draft the findings deck'
  },
  'chat-1': { bot: `${LONG_BOT} 02`, chat: 'Home' },
  'chat-2': { bot: 'UX Designer', chat: PROMPTS[0] ?? '' }
}

/** Focuses the second row's label from the keyboard, so its full-name tooltip opens. */
async function focusSecondRow(frame: HTMLElement): Promise<void> {
  const labels = frame.querySelectorAll<HTMLElement>('li [tabindex="0"]')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  labels[1]?.focus()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

function LongNamesToast(): React.JSX.Element {
  return (
    <NativeChatResumeToast
      view={resumeToastView(
        finishedRun(twelve.slice(0, 4), 'launch'),
        [],
        new Map([[notAttached.sessionId, notAttached]])
      )}
      listedAt={NOW}
      defaultExpanded
      {...actions}
      {...botChats(LONG_NAME_CHATS)}
    />
  )
}

/** Narrowest toast: the chat title truncates before a long bot name; the age and actions stay. */
export const botChatsLongNames = defineFixture({
  width: NARROWEST,
  render: () => <LongNamesToast />
})

/** Two names alike up to the ellipsis: a keyboard focus on the row shows the whole one. */
export const botChatsLongNamesFocused = defineFixture({
  width: NARROWEST,
  render: () => <LongNamesToast />,
  interact: focusSecondRow
})

const UNBROKEN = 'W'.repeat(62)

/** Two unbroken 63-character names that differ only at the end: the tooltip wraps inside the window. */
export const botChatsUnbrokenNamesFocused = defineFixture({
  width: NARROWEST,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(finishedRun(twelve.slice(0, 3), 'launch'), [], new Map())}
      listedAt={NOW}
      defaultExpanded
      {...actions}
      {...botChats({
        'chat-0': { bot: `${UNBROKEN}A`, chat: 'Home' },
        'chat-1': { bot: `${UNBROKEN}B`, chat: 'Home' }
      })}
    />
  ),
  interact: focusSecondRow
})

const LONG_SEPARATOR = ' ———————— a forty-eight character separator ——— '

const longSeparatorT: Translate = (key, fallback, options) =>
  key === 'auto.components.NativeChatResumeToast.botChat'
    ? `${String(options?.bot)}${LONG_SEPARATOR}${String(options?.chat)}`
    : translate(key, fallback, options)
const LONG_SEPARATOR_SCOPE = { intlLocale: 'en', t: longSeparatorT }

/** A translation with too much text around the names shows in the default order, so the names stay in view. */
export const botChatsLongSeparator = defineFixture({
  width: NARROWEST,
  render: () => (
    <TranslationScopeContext.Provider value={LONG_SEPARATOR_SCOPE}>
      <NativeChatResumeToast
        view={resumeToastView(finishedRun(twelve.slice(0, 3), 'launch'), [], new Map())}
        listedAt={NOW}
        defaultExpanded
        {...actions}
        {...botChats(BOT_CHATS)}
      />
    </TranslationScopeContext.Provider>
  )
})

type FixtureLanguage =
  | 'en'
  | 'de'
  | 'ru'
  | 'es'
  | 'fr'
  | 'ja'
  | 'ko'
  | 'pt'
  | 'tr'
  | 'zh'
  | 'zh-Hant'

function twelveOneNeedsYouIn(language: FixtureLanguage, width = NARROWEST) {
  return defineFixture({
    width,
    render: () => (
      <NativeChatResumeToast
        view={resumeToastView(
          finishedRun(twelve, 'launch'),
          [],
          new Map([[notAttached.sessionId, notAttached]])
        )}
        listedAt={NOW}
        defaultExpanded
        {...actions}
      />
    ),
    interact: async () => {
      await setRendererUiLanguage(language)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })
}

export const twelveOneNeedsYouGerman = twelveOneNeedsYouIn('de')
export const twelveOneNeedsYouRussian = twelveOneNeedsYouIn('ru')

/** The frame pads 16 px a side, so this renders the toast at its real 26rem (416 px). */
const TOAST_WIDTH = 448
export const twelveOneNeedsYouEnglish416 = twelveOneNeedsYouIn('en', TOAST_WIDTH)
export const twelveOneNeedsYouGerman416 = twelveOneNeedsYouIn('de', TOAST_WIDTH)
export const twelveOneNeedsYouRussian416 = twelveOneNeedsYouIn('ru', TOAST_WIDTH)

export const offerManualDetails416 = defineFixture({
  width: TOAST_WIDTH,
  render: () => (
    <NativeChatResumeToast
      view={resumeToastView(null, twelve.slice(0, 3), new Map())}
      listedAt={NOW}
      onDismissAll={noop}
      defaultExpanded
      {...actions}
    />
  )
})

function offerManualDetailsIn(language: FixtureLanguage) {
  return defineFixture({
    width: TOAST_WIDTH,
    render: () => (
      <NativeChatResumeToast
        view={resumeToastView(null, twelve.slice(0, 3), new Map())}
        listedAt={NOW}
        onDismissAll={noop}
        defaultExpanded
        {...actions}
      />
    ),
    interact: async () => {
      await setRendererUiLanguage(language)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })
}

export const offerManualDetailsGerman416 = offerManualDetailsIn('de')
export const offerManualDetailsRussian416 = offerManualDetailsIn('ru')

// Every bundled locale at the real toast width, for fit and copy review.
export const twelveOneNeedsYouSpanish416 = twelveOneNeedsYouIn('es', TOAST_WIDTH)
export const twelveOneNeedsYouFrench416 = twelveOneNeedsYouIn('fr', TOAST_WIDTH)
export const twelveOneNeedsYouJapanese416 = twelveOneNeedsYouIn('ja', TOAST_WIDTH)
export const twelveOneNeedsYouKorean416 = twelveOneNeedsYouIn('ko', TOAST_WIDTH)
export const twelveOneNeedsYouPortuguese416 = twelveOneNeedsYouIn('pt', TOAST_WIDTH)
export const twelveOneNeedsYouTurkish416 = twelveOneNeedsYouIn('tr', TOAST_WIDTH)
export const twelveOneNeedsYouChinese416 = twelveOneNeedsYouIn('zh', TOAST_WIDTH)
export const twelveOneNeedsYouChineseTraditional416 = twelveOneNeedsYouIn('zh-Hant', TOAST_WIDTH)
export const offerManualDetailsSpanish416 = offerManualDetailsIn('es')
export const offerManualDetailsFrench416 = offerManualDetailsIn('fr')
export const offerManualDetailsJapanese416 = offerManualDetailsIn('ja')
export const offerManualDetailsKorean416 = offerManualDetailsIn('ko')
export const offerManualDetailsPortuguese416 = offerManualDetailsIn('pt')
export const offerManualDetailsTurkish416 = offerManualDetailsIn('tr')
export const offerManualDetailsChinese416 = offerManualDetailsIn('zh')
export const offerManualDetailsChineseTraditional416 = offerManualDetailsIn('zh-Hant')
