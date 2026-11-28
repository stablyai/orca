import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { mascotAvatar } from '../../../../../shared/bot-avatar'
import type { Bot } from '../../../../../shared/bot-types'
import type { TeamShareOwner, TeamSharePerson, TeamShareSuggestion } from './bot-team-share-people'
import { BotTeamShareDialog } from './BotTeamShareDialog'

const BOT: Bot = {
  id: 'ivy',
  name: 'Ivy',
  hostId: 'local',
  folder: 'ivy',
  folderWorkspaceId: 'fw-ivy',
  agent: 'claude',
  avatar: mascotAvatar('G1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const OWNER: TeamShareOwner = {
  name: 'Jinwoo Hong',
  email: 'jinwoo@stably.ai',
  links: ['slack', 'github', 'linear']
}

const PEOPLE = {
  alice: {
    kind: 'account',
    key: 'alice',
    name: 'Alice Chen',
    email: 'alice@stably.ai',
    links: ['slack', 'github', 'linear']
  },
  bo: { kind: 'account', key: 'bo', name: 'Bo Park', email: 'bo@stably.ai', links: ['github'] },
  sam: { kind: 'slack', key: 'sam', name: 'Sam Ruiz', handle: '@sam', workspace: 'Stably' },
  octo: { kind: 'github', key: 'octo', login: 'octo-dev', place: 'stablyai', linkedAccounts: 2 },
  tom: { kind: 'github', key: 'tom', login: 'tom-okafor', place: 'stablyai' },
  dana: { kind: 'invite', key: 'dana', email: 'dana@acme.co' },
  danaJoined: { kind: 'account', key: 'dana', name: 'Dana Wu', email: 'dana@acme.co', links: [] },
  mei: {
    kind: 'account',
    key: 'mei',
    name: 'Mei Tanaka',
    email: 'mei@stably.ai',
    links: ['slack']
  },
  raj: {
    kind: 'account',
    key: 'raj',
    name: 'Raj Patel',
    email: 'raj@stably.ai',
    links: ['slack', 'github']
  },
  lena: {
    kind: 'account',
    key: 'lena',
    name: 'Lena Fischer',
    email: 'lena@stably.ai',
    links: ['linear']
  },
  ana: { kind: 'slack', key: 'ana', name: 'Ana Ruiz', handle: '@ana', workspace: 'Stably' },
  boWaiting: {
    kind: 'account',
    key: 'bo',
    name: 'Bo Park',
    email: 'bo@stably.ai',
    links: [],
    answer: 'pending'
  },
  eli: {
    kind: 'account',
    key: 'eli',
    name: 'Eli Ross',
    email: 'eli@stably.ai',
    links: [],
    answer: 'declined'
  }
} satisfies Record<string, TeamSharePerson>

type PersonKey = keyof typeof PEOPLE

const FOUND: Record<string, readonly TeamShareSuggestion[]> = {
  '@alice': [
    {
      kind: 'account',
      key: 'alice',
      name: 'Alice Chen',
      detail: 'alice@stably.ai · @alice on Slack',
      links: ['slack', 'github', 'linear']
    },
    { kind: 'slack', key: 'alicia', name: 'Alicia Gómez', detail: '@alicia' }
  ],
  alex: [
    { kind: 'account', key: 'alex', name: 'Alex Kim', detail: '@alex on Slack', links: ['slack'] },
    { kind: 'slack', key: 'alexis', name: 'Alexis Moreau', detail: '@alexis' },
    { kind: 'github', key: 'alex-dev', name: 'alex-dev' },
    { kind: 'invite', key: 'invite', email: 'alex@stably.ai' }
  ],
  'dana@acme.co': [{ kind: 'invite', key: 'invite', email: 'dana@acme.co' }],
  '@alcie': [],
  sam: Array.from({ length: 14 }, (_, index) => ({
    kind: 'slack' as const,
    key: `sam-${index}`,
    name: `Sam ${String.fromCharCode(65 + index)}.`,
    detail: `@sam${index + 1}`
  }))
}

const STAGED: Record<string, TeamShareSuggestion> = {
  dana: { kind: 'invite', key: 'dana@acme.co', email: 'dana@acme.co' },
  alicia: { kind: 'slack', key: 'alicia', name: 'Alicia Gómez', detail: 'Stably' }
}

const NONE_STAGED: readonly (keyof typeof STAGED)[] = []

function Scene({
  people: initial,
  query: initialQuery = '',
  staged: initialStaged = NONE_STAGED
}: {
  people: readonly PersonKey[]
  query?: string
  staged?: readonly (keyof typeof STAGED)[]
}): React.JSX.Element {
  const [people, setPeople] = useState<TeamSharePerson[]>(initial.map((key) => PEOPLE[key]))
  const [query, setQuery] = useState(initialQuery)
  const [staged, setStaged] = useState<TeamShareSuggestion[]>(
    initialStaged.map((key) => STAGED[key])
  )
  return (
    <div className="min-h-[640px]">
      <BotTeamShareDialog
        bot={BOT}
        hostName="Jinwoo’s MacBook Pro"
        owner={OWNER}
        people={people}
        othersListed={people.length > 0}
        query={query}
        onQueryChange={setQuery}
        suggestions={query.trim() === '' ? null : (FOUND[query.trim()] ?? [])}
        staged={staged}
        onStage={(suggestion) => {
          setQuery('')
          setStaged([...staged, suggestion])
        }}
        onUnstage={(suggestion) =>
          setStaged(staged.filter((entry) => entry.key !== suggestion.key))
        }
        onShare={() => {
          setPeople([
            ...people,
            ...staged.map((entry): TeamSharePerson =>
              entry.kind === 'invite'
                ? { kind: 'invite', key: entry.key, email: entry.email }
                : { kind: 'slack', key: entry.key, name: entry.name, workspace: 'Stably' }
            )
          ])
          setStaged([])
        }}
        onCancelStaged={() => setStaged([])}
        onRemove={(person) => setPeople(people.filter((entry) => entry.key !== person.key))}
        onResend={() => {}}
        onShareAgain={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}

function scene(
  people: readonly PersonKey[],
  opts: { query?: string; staged?: readonly (keyof typeof STAGED)[]; interact?: () => void } = {}
) {
  return defineFixture({
    width: 760,
    render: () => <Scene people={people} query={opts.query} staged={opts.staged} />,
    interact: opts.interact
  })
}

/** One list: Orca accounts with the accounts they linked, a Slack-only person, a shared GitHub login. */
export const people = scene(['alice', 'bo', 'sam', 'octo'])

/** Typing a Slack name: Alice's Orca account comes first, then a Slack-only match. */
export const typing = scene(['bo', 'sam'], { query: '@alice' })

/** Every kind of result in one field. */
export const mixed = scene(['alice', 'bo'], { query: 'alex' })

/** A typed email offers an invite. */
export const inviteEmail = scene(['alice', 'bo'], { query: 'dana@acme.co' })

/** Nothing matches the name, so nothing can be added. */
export const noMatch = scene(['alice', 'bo', 'sam'], { query: '@alcie' })

/** Picked people wait in the field as chips; nothing is saved until Share. */
export const staged = scene(['alice', 'bo'], { staged: ['dana', 'alicia'] })

/** After Share: the invite is greyed out as Invited until they accept. */
export const invited = scene(['alice', 'bo', 'sam', 'dana'])

/** The invite resolved: Dana has access as her Orca account. */
export const hasAccess = scene(['alice', 'bo', 'danaJoined'])

/** A pending invite's menu: Resend invite and Remove. */
export const inviteMenu = scene(['alice', 'bo', 'dana'], {
  interact: () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Invite actions for dana@acme.co"]'
    )
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})

/** Each answer: accepted, an account and an email invited but not in yet (greyed), and declined. */
export const answers = scene(['alice', 'boWaiting', 'dana', 'eli'])

/** One of each: has access, invited, declined. */
export const rows = scene(['alice', 'dana', 'eli'])

/** A declined person's menu: Share again and Remove. */
export const declinedMenu = scene(['alice', 'boWaiting', 'dana', 'eli'], {
  interact: () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Eli Ross"]'
    )
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})

/** Nobody added yet. */
export const onlyYou = scene([])

/** A long list scrolls; the Add field and the footer stay put. */
export const many = scene(['alice', 'bo', 'sam', 'octo', 'mei', 'raj', 'lena', 'tom', 'ana'])

/** Many matches scroll; Up wraps to the last one and the list follows it, focus kept in the field. */
export const manySuggestions = scene(['alice', 'bo'], {
  query: 'sam',
  interact: () => {
    document
      .querySelector<HTMLInputElement>('input[role="combobox"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  }
})
