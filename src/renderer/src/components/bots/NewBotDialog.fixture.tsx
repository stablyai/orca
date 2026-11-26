import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { BOT_TEMPLATES } from '../../../../shared/bots/bot-templates'
import { templateProposal, type BotProposal } from '../../../../shared/bots/bot-proposal'
import type { BotShareReview } from '../../../../shared/bots/bot-share-received'
import { NewBotDialog } from './NewBotDialog'
import { refreshAvatarCapability } from './avatar-generation-capability-store'
import {
  LONG_FIXTURE_COMPUTER,
  NewBotFixtureStage,
  newBotFixture,
  seedNewBotFixture,
  typeInto
} from './new-bot-stage-fixture'

const dialog = () => (
  <div className="h-[720px] bg-background">
    <NewBotDialog open onOpenChange={() => {}} />
  </div>
)

const longProposal: BotProposal = {
  name: 'Eng-Bot-Builder',
  mascot: 'B1',
  purpose:
    'I build Orca bots for Carol, and every bot I recruit follows ~/.orca/bots/company_guide.md.',
  watches:
    'Requests to create, revise, or retire an Orca bot, plus the roster in ~/.orca/bots so a new bot never duplicates one that already exists, and any change to ~/.orca/bots/company_guide.md.',
  does: "Checks the roster so it does not duplicate a bot, drafts the new bot's purpose and SOUL.md, and proposes it as a card. Every bot it recruits has to follow ~/.orca/bots/company_guide.md: GitHub comments and pull requests only as carol-gh, and community pull requests get credit to their original author in the description.",
  reports:
    'A Create-bot card for Carol to accept, then which bot was made, what it watches, and anything in the company guide it could not follow.'
}

const proposed = (height: number, proposal: BotProposal, origin: string) => () => (
  <div className="bg-background" style={{ height }}>
    <NewBotDialog open onOpenChange={() => {}} proposal={proposal} origin={origin} />
  </div>
)

const typed = (purpose: string) => async (): Promise<void> => {
  await typeInto('[role="dialog"] input[autocomplete="off"]', 'Pulse')()
  await typeInto('[role="dialog"] textarea', purpose)()
  document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.focus()
}

export const blank = defineFixture({ width: 720, setup: () => stubBots([]), render: dialog })

export const purpose = defineFixture({
  width: 720,
  setup: () => stubBots([]),
  render: dialog,
  interact: typed('Watch app startup time and catch regressions')
})

export const longPurpose = defineFixture({
  width: 720,
  setup: () => stubBots([]),
  render: dialog,
  interact: typed(
    'Watch app startup time on macOS, Windows and Linux, compare each new PR against main, and tell me in #perf when cold start gets more than 5% slower. Post a short summary there every Friday.'
  )
})

// Over the limit, as a value set past the box's maxLength arrives: Create shows Too long and sends nothing.
export const tooLongPurpose = defineFixture({
  ...newBotFixture(480),
  interact: async () => {
    await typeInto('input[autocomplete="off"]', 'Pulse')()
    await typeInto(
      'textarea',
      'Watch app startup time and catch regressions on every platform. '.repeat(17)
    )()
    document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await new Promise(requestAnimationFrame)
  }
})

export const proposal = defineFixture({
  width: 1100,
  setup: () => stubBots([]),
  render: proposed(1000, longProposal, 'Proposed by CoS')
})

export const template = defineFixture({
  width: 1100,
  setup: () => stubBots([]),
  render: proposed(820, templateProposal(BOT_TEMPLATES[0]), 'From Support triage')
})

// A long (189-character) purpose, for short-window checks of the pinned footer.
export const proposalLongPurpose = defineFixture({
  width: 1100,
  setup: () => stubBots([]),
  render: proposed(
    1000,
    {
      ...longProposal,
      purpose:
        'I build Orca bots for Carol, and every bot I recruit follows ~/.orca/bots/company_guide.md, checks the roster first, and never duplicates a bot that already exists here.'
    },
    'Proposed by CoS'
  )
})

// A Hermes bot on this computer, so the first-bot import nudge shows.
const HERMES_SOURCES = [
  {
    app: 'hermes',
    home: '~/.hermes',
    bots: [{ agent: 'atlas', name: 'Atlas', path: '~/.hermes/atlas', absolutePath: '/x/atlas' }]
  }
]

const withNudge = (): void => {
  seedNewBotFixture()()
  try {
    localStorage.removeItem('orca.bots.import-nudge-dismissed')
  } catch {
    // The nudge stays hidden; the shot shows it missing.
  }
  const runtime = window.api.runtime
  const call = runtime.call.bind(runtime)
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (request: Parameters<typeof call>[0]) =>
      request.method === 'bots.import.sources'
        ? { ok: true, result: { sources: HERMES_SOURCES } }
        : call(request)
  })
}

const named = (name: string, identity: string) => async (): Promise<void> => {
  await typeInto('[role="dialog"] input[autocomplete="off"]', name)()
  await typeInto('[role="dialog"] textarea', identity)()
  document.querySelector<HTMLElement>('[role="dialog"]')?.focus()
}

const openPicker = async (): Promise<void> => {
  document.querySelector<HTMLButtonElement>('button[aria-label="Change picture"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const openComputerMenu = async (): Promise<void> => {
  document.querySelector<HTMLInputElement>('input[role="combobox"][aria-label="Computer"]')?.focus()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const FILLED = named('Atlas', 'Triage new bugs and post a daily summary in #eng.')
const LONGEST = named(
  'Customer Escalations Concierge for the Platform Team',
  [
    'Owns customer escalations.',
    'Triages new bugs tagged customer.',
    'Finds the owner from CODEOWNERS.',
    'Pages the on-call engineer in #oncall.',
    'Posts a summary once it is fixed.'
  ].join('\n')
)

export const nudge340 = defineFixture({
  width: 372,
  setup: withNudge,
  render: () => <NewBotFixtureStage width={340} nudge />
})
export const nudge480 = defineFixture({
  width: 512,
  setup: withNudge,
  render: () => <NewBotFixtureStage width={480} nudge />
})
export const empty340 = defineFixture(newBotFixture(340))
export const empty480 = defineFixture(newBotFixture(480))

export const filled340 = defineFixture({ ...newBotFixture(340), interact: FILLED })
export const filled480 = defineFixture({ ...newBotFixture(480), interact: FILLED })
export const longest340 = defineFixture({
  ...newBotFixture(340, LONG_FIXTURE_COMPUTER),
  interact: LONGEST
})
export const longest480 = defineFixture({
  ...newBotFixture(480, LONG_FIXTURE_COMPUTER),
  interact: LONGEST
})
const pictureReview = (width: 340 | 480) => ({
  width: width + 32,
  setup: () => {
    seedNewBotFixture('Demo computer')()
    const avatarGeneration: typeof window.api.avatarGeneration = {
      ...window.api.avatarGeneration,
      capability: async () => ({ agents: [{ agent: 'codex', status: 'ready' }] })
    }
    Reflect.set(window.api, 'avatarGeneration', avatarGeneration)
    refreshAvatarCapability()
  },
  render: () => (
    <NewBotFixtureStage
      width={width}
      proposal={{ name: 'Pebble', purpose: 'Sort invented notes for the demo.', mascot: 'B1' }}
    />
  )
})

export const picker340 = defineFixture({ ...pictureReview(340), interact: openPicker })
export const picker480 = defineFixture({ ...pictureReview(480), interact: openPicker })

const reopenDraft = async (): Promise<void> => {
  await openPicker()
  document.querySelector<HTMLButtonElement>('button[aria-label="Previous picture"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
  await typeInto('textarea[aria-label="Picture description"]', 'a tiny violet robot gardener')()
  const popover = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
  popover?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  await openPicker()
  document.querySelector<HTMLButtonElement>('button[aria-label="Previous picture"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 400))
}

export const pictureDraft340 = defineFixture({
  ...pictureReview(340),
  interact: reopenDraft
})
export const pictureDraft480 = defineFixture({
  ...pictureReview(480),
  interact: reopenDraft
})
export const computerMenu340 = defineFixture({
  ...newBotFixture(340, LONG_FIXTURE_COMPUTER),
  interact: openComputerMenu
})
export const computerMenu480 = defineFixture({
  ...newBotFixture(480, LONG_FIXTURE_COMPUTER),
  interact: openComputerMenu
})

// From a template: PR review (1 skill, 1 automation, GitHub) and Security check, the most parts.
const fromTemplate = (id: string, name?: string) => {
  const found = BOT_TEMPLATES.find((entry) => entry.id === id)
  return found ? templateProposal(found, name ? { name } : {}) : undefined
}
const templateReview = (width: 340 | 480, id: string, name?: string) => ({
  width: width + 32,
  setup: seedNewBotFixture(),
  render: () => <NewBotFixtureStage width={width} height={1100} proposal={fromTemplate(id, name)} />
})
const openChip = (label: RegExp) => async (): Promise<void> => {
  const chip = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => label.test(button.textContent ?? '')
  )
  chip?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
}
const skillOff = async (): Promise<void> => {
  await openChip(/skill/)()
  document.querySelector<HTMLButtonElement>('[role="switch"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const LONG_TEMPLATE_NAME = 'Customer Escalations Concierge for the Platform Reliability Team'

export const prReview340 = defineFixture(templateReview(340, 'pr-review'))
export const prReview480 = defineFixture(templateReview(480, 'pr-review'))
export const largest340 = defineFixture(templateReview(340, 'security-check'))
export const largest480 = defineFixture(templateReview(480, 'security-check'))
export const manyApps340 = defineFixture(templateReview(340, 'meeting-prep'))
export const longName340 = defineFixture(templateReview(340, 'pr-review', LONG_TEMPLATE_NAME))
export const longName480 = defineFixture(templateReview(480, 'pr-review', LONG_TEMPLATE_NAME))
export const skillsOpen340 = defineFixture({
  ...templateReview(340, 'pr-review'),
  interact: openChip(/skill/)
})
export const skillOff340 = defineFixture({
  ...templateReview(340, 'pr-review'),
  interact: skillOff
})
export const appsOpen340 = defineFixture({
  ...templateReview(340, 'meeting-prep'),
  interact: openChip(/apps|GitHub|Google/)
})
export const schedulesOpen480 = defineFixture({
  ...templateReview(480, 'email-digest'),
  interact: openChip(/schedule/)
})

const LONGEST_LINK: BotShareReview = {
  reviewId: 'review-1',
  shareId: 'share-1',
  versionId: 'version-1',
  publisher: 'Example Studio',
  publishedAt: '2026-11-08T00:00:00.000Z',
  bot: {
    schemaVersion: 1,
    name: 'Customer Escalations Concierge for the Platform Team',
    avatar: { mascot: 'B1' },
    purpose: 'Owns customer escalations.',
    agentHint: 'claude',
    skills: [],
    tools: [],
    connectors: [],
    schedules: [],
    eventSuggestions: [],
    memory: []
  },
  files: [],
  flags: [],
  leftOut: [],
  avatarDataUrl: null
}

const fromLink = (width: 340 | 480) => ({
  width: width + 32,
  setup: seedNewBotFixture(LONG_FIXTURE_COMPUTER),
  render: () => <NewBotFixtureStage width={width} link={LONGEST_LINK} />,
  interact: (frame: HTMLElement) => {
    const name = frame.querySelector<HTMLInputElement>('input[aria-label="Name"]')
    if (!name || document.activeElement === name || frame.querySelector('textarea')) {
      throw new Error(
        'A reviewed link must open with a prefilled, unfocused name and no Identity input'
      )
    }
  }
})

// The link flow's New bot: the same dialog, prefilled from the link, beside longest340/480.
export const link340 = defineFixture(fromLink(340))
export const link480 = defineFixture(fromLink(480))

// The shared link in the locales with the longest Use chat defaults: the footer stays on one row.
const linkIn = (language: 'de' | 'es' | 'ru') => ({
  ...fromLink(340),
  interact: async (frame: HTMLElement) => {
    fromLink(340).interact(frame)
    await i18n.changeLanguage(await loadRendererUiLanguage(language))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const footer = document.querySelector<HTMLElement>('[data-slot="dialog-footer"]')
    const start = footer?.querySelector<HTMLElement>('[data-slot="dialog-footer-start"]')
    const actions = footer?.querySelector<HTMLElement>('[data-slot="dialog-footer-actions"]')
    if (!start?.textContent || !actions) {
      throw new Error('Use chat defaults must show for a link that keeps Ask')
    }
    if (Math.abs(start.getBoundingClientRect().top - actions.getBoundingClientRect().top) > 8) {
      throw new Error('The footer must stay on one row')
    }
  }
})
export const linkDe340 = defineFixture(linkIn('de'))
export const linkEs340 = defineFixture(linkIn('es'))
export const linkRu340 = defineFixture(linkIn('ru'))

// A model picked, so Use chat defaults shows on the footer's left.
const pickModelOnly = async (): Promise<void> => {
  const trigger = document.querySelector<HTMLElement>(
    '[role="dialog"] [role="group"][aria-label="Agent"] button'
  )
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const label = [...document.querySelectorAll<HTMLElement>('[role="menu"] *')].find(
    (node) => node.childElementCount === 0 && node.textContent?.trim() === 'Opus'
  )
  const opus = label?.closest<HTMLElement>('[role="option"]')
  opus?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  )
  const focused = document.activeElement
  if (focused instanceof HTMLElement) {
    focused.blur()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
}
const pickModel = async (): Promise<void> => {
  await FILLED()
  await pickModelOnly()
}
export const chatDefaultsTemplate340 = defineFixture({
  ...newBotFixture(340),
  interact: pickModelOnly
})
export const chatDefaults340 = defineFixture({ ...newBotFixture(340), interact: pickModel })
export const chatDefaults480 = defineFixture({ ...newBotFixture(480), interact: pickModel })
export const chatDefaultsFocus340 = defineFixture({
  ...newBotFixture(340),
  interact: async () => {
    await pickModel()
    const link = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'Use chat defaults'
    )
    link?.focus()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
