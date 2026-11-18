import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { BOT_TEMPLATES } from '../../../../shared/bots/bot-templates'
import { templateProposal, type BotProposal } from '../../../../shared/bots/bot-proposal'
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
