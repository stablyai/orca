import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { useAppStore } from '@/store'
import { PortalContainerContext } from '../ui/portal-container-context'
import { BOT_TEMPLATES } from '../../../../shared/bots/bot-templates'
import { templateProposal, type BotProposal } from '../../../../shared/bots/bot-proposal'
import type { BotShareReview } from '../../../../shared/bots/bot-share-received'
import { NewBotDialog } from './NewBotDialog'

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

// Types into the controlled fields the way a person would, so React sees the change.
const typeInto = (selector: string, text: string) => async (): Promise<void> => {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (!field) {
    return
  }
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Reflect.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 50))
}

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

// Review shots at a 340 and a 480 px dialog. The dialog is fixed, so it portals into a transformed box
// that wide (plus its 1rem margins) instead of the page's wide viewport.
function Stage({
  width,
  nudge,
  proposal,
  height = 620,
  link
}: {
  width: 340 | 480
  nudge?: boolean
  proposal?: BotProposal
  height?: number
  /** Opened from a reviewed link, as the link flow opens it. */
  link?: BotShareReview
}): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative translate-x-0 bg-background"
      style={{ width: width + 32, height }}
    >
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <NewBotDialog
            open
            onOpenChange={() => {}}
            onImport={nudge ? () => {} : undefined}
            proposal={proposal}
            {...(link
              ? { fromShare: { review: link, toolIds: [], onBack: () => {}, onMoved: () => {} } }
              : {})}
          />
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

const LONG_COMPUTER = 'build-runner-02.eu-west.internal'

const seeded = (computer?: string) => (): void => {
  stubBots([])
  useAppStore.setState((state) => ({
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: {
      host: ['claude', 'codex'],
      'host\u0000all-agents': ['claude', 'codex']
    },
    ensureDetectedAgents: async () => ['claude', 'codex'],
    isDetectingAgents: false,
    settings: state.settings && {
      ...state.settings,
      hostSettingOverrides: computer ? { local: { displayLabel: computer } } : {}
    }
  }))
}

// A Hermes bot on this computer, so the first-bot import nudge shows.
const HERMES_SOURCES = [
  {
    app: 'hermes',
    home: '~/.hermes',
    bots: [{ agent: 'atlas', name: 'Atlas', path: '~/.hermes/atlas', absolutePath: '/x/atlas' }]
  }
]

const withNudge = (): void => {
  seeded()()
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

const review = (width: 340 | 480, computer?: string) => ({
  width: width + 32,
  setup: seeded(computer),
  render: () => <Stage width={width} />
})

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
  render: () => <Stage width={340} nudge />
})
export const nudge480 = defineFixture({
  width: 512,
  setup: withNudge,
  render: () => <Stage width={480} nudge />
})
export const empty340 = defineFixture(review(340))
export const empty480 = defineFixture(review(480))
export const filled340 = defineFixture({ ...review(340), interact: FILLED })
export const filled480 = defineFixture({ ...review(480), interact: FILLED })
export const longest340 = defineFixture({ ...review(340, LONG_COMPUTER), interact: LONGEST })
export const longest480 = defineFixture({ ...review(480, LONG_COMPUTER), interact: LONGEST })
export const picker340 = defineFixture({ ...review(340), interact: openPicker })
export const picker480 = defineFixture({ ...review(480), interact: openPicker })
export const computerMenu340 = defineFixture({
  ...review(340, LONG_COMPUTER),
  interact: openComputerMenu
})
export const computerMenu480 = defineFixture({
  ...review(480, LONG_COMPUTER),
  interact: openComputerMenu
})

// From a template: PR review (1 skill, 1 automation, GitHub) and Security check, the most parts.
const fromTemplate = (id: string, name?: string) => {
  const found = BOT_TEMPLATES.find((entry) => entry.id === id)
  return found ? templateProposal(found, name ? { name } : {}) : undefined
}
const templateReview = (width: 340 | 480, id: string, name?: string) => ({
  width: width + 32,
  setup: seeded(),
  render: () => <Stage width={width} height={1100} proposal={fromTemplate(id, name)} />
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
const LONG_TEMPLATE_NAME = 'Pull request review for the Platform Team monorepo'

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
  publisher: 'Alexandra Whitfield',
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
  setup: seeded(LONG_COMPUTER),
  render: () => <Stage width={width} link={LONGEST_LINK} />
})

// The link flow's New bot: the same dialog, prefilled from the link, beside longest340/480.
export const link340 = defineFixture(fromLink(340))
export const link480 = defineFixture(fromLink(480))
