import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { useAppStore } from '@/store'
import { PortalContainerContext } from '../ui/portal-container-context'
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

// Review shots at a 340 and a 480 px dialog. The dialog is fixed, so it portals into a transformed box
// that wide (plus its 1rem margins) instead of the page's wide viewport.
function Stage({ width }: { width: 340 | 480 }): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative h-[620px] translate-x-0 bg-background"
      style={{ width: width + 32 }}
    >
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <NewBotDialog open onOpenChange={() => {}} />
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
