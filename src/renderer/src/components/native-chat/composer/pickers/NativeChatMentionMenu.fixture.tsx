import { useMemo } from 'react'
import { BotMentionHostText } from '@/components/bots/BotMentionHostBadge'
import type { NativeChatRoomMention } from '../native-chat-composer-types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { BotAvatarTile } from '../../../bots/BotAvatar'
import { rankNativeChatRoomMembers } from '../../../../../../shared/native-chat/input/native-chat-room-mentions'
import { NativeChatRoomContext } from '../../native-chat-room-context'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { NativeChatMentionMenu } from './NativeChatAutocompleteMenus'

// A seeded roster ranked by the real matcher. File results stand in for a connected workspace.
const BOTS: [name: string, detail: string, emoji: string, paused?: true][] = [
  ['Garden', 'Review open pull requests (PR) for the sample garden planner.', '🌱'],
  ['Sketch', 'Review form labels and diagrams.', '🎨'],
  ['Compass', 'Assign incoming requests to the sample team.', '🧭'],
  ['Eng - Timing', 'Measure the time needed to draw a route.', '⚡'],
  ['Release Scribe', 'Write release summaries for the example application.', '📦'],
  ['Eng - Locale', 'Check the coverage of translated examples in the sample catalog.', '🌐'],
  ['Eng - Widgets', '', '🔌'],
  ['Eng - Builds', 'Run the sample build and explain failed jobs.', '🐧'],
  ['Eng-Extensions', 'Maintain the sample extension catalog.', '🧩'],
  ['Eng - Nell', 'Review changes to the example map.', '🦉'],
  ['Eng-Map-Builder', 'Build route tiles for the sample atlas.', '🤖'],
  ['Campaign Planner', 'Plan small experiments and track audience growth.', '📣'],
  ['Eng - River', 'Trace bugs in the sample river map.', '🧠'],
  ['X-Ray Export', '', '✖️', true],
  ['Planner', 'Summarize feedback on sample routes.', '📝']
]
type Member = NativeChatRoomMention
const MEMBERS: Member[] = BOTS.map(([name, detail, emoji, paused]) => ({
  name,
  icon: <BotAvatarTile src={null} fallback={emoji} className="size-4.5 shrink-0" />,
  ...(detail ? { detail } : {}),
  ...(paused ? { unavailable: 'Paused' } : {})
}))
const RECENT = ['review-local', 'review-remote', 'Eng - Nell', 'Compass', 'Eng-Map-Builder']
const FILES = [
  'src/renderer/src/components/bots/BotAvatar.tsx',
  'docs/engineering/review-flow.md',
  'src/shared/native-chat/input/native-chat-room-mentions.ts',
  'README.md'
]

function rankedRoom(query: string, members: Member[], withFiles: boolean) {
  const { matches, recentCount } = rankNativeChatRoomMembers(members, query, RECENT)
  const needle = query.toLowerCase()
  const files =
    !withFiles || /\s/.test(query)
      ? []
      : FILES.filter((path) => path.toLowerCase().includes(needle)).slice(0, needle ? 3 : 2)
  return {
    rows: [...matches.filter((match) => !match.unavailable).map((match) => match.value), ...files],
    room: {
      replies: null,
      mentions: members,
      withFiles,
      unavailable: matches.filter((match) => match.unavailable).map((match) => match.value),
      matches,
      recentCount,
      query
    }
  }
}

function MentionPicker({
  query,
  members = MEMBERS,
  withFiles = true,
  textSize
}: {
  query: string
  members?: Member[]
  withFiles?: boolean
  textSize?: number
}): React.JSX.Element {
  const { rows, room } = useMemo(
    () => rankedRoom(query, members, withFiles),
    [query, members, withFiles]
  )
  return (
    <div
      className="native-chat-appearance bg-background px-4 pb-4"
      style={{
        ...nativeChatAppearanceStyle({ nativeChatAppearance: { fontSize: textSize } }),
        paddingTop: 460
      }}
    >
      <NativeChatRoomContext.Provider value={room}>
        <div className="relative">
          <NativeChatMentionMenu
            mention={{ files: rows, loading: false, failed: false }}
            activeIndex={0}
            listboxId="mentions"
            onChoose={() => {}}
            onHover={() => {}}
          />
          <div className="h-16 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground">
            ask @{query}
          </div>
        </div>
      </NativeChatRoomContext.Provider>
    </div>
  )
}

const picker = (query: string) =>
  defineFixture({ width: 560, render: () => <MentionPicker query={query} /> })

const REVIEWERS: Member[] = [
  {
    name: 'Eng - Review Desk',
    id: 'one',
    key: 'review-local',
    recentKey: 'review-local',
    icon: MEMBERS[0].icon,
    detail: 'Review changes before release.'
  },
  {
    name: 'Eng - Review Desk',
    id: 'two',
    key: 'review-remote',
    recentKey: 'review-remote',
    icon: MEMBERS[1].icon,
    detail: 'Review changes on the build server.',
    host: <BotMentionHostText label="Build server" offline />,
    dimmed: true
  },
  ...MEMBERS
]
export const pairedRecent = defineFixture({
  width: 320,
  render: () => <MentionPicker query="" members={REVIEWERS} textSize={20} />
})
export const pairedWords = defineFixture({
  width: 360,
  render: () => <MentionPicker query="eng rev" members={REVIEWERS} textSize={20} />
})
export const pairedPunctuation = defineFixture({
  width: 360,
  render: () => <MentionPicker query="eng-rev" members={REVIEWERS} textSize={20} />
})

export const bareAt = picker('')
export const eng = picker('eng')
export const engSpaceN = picker('eng n')
export const engneil = picker('engnell')
export const purposeReview = picker('review')
export const purposeShortPr = picker('pr')
export const noMatch = picker('xyz')
export const pausedOnly = picker('x')
export const filesNoBots = picker('readme')
const narrow = (width: number, query: string) =>
  defineFixture({ width, render: () => <MentionPicker query={query} /> })
export const growth360 = narrow(360, 'growth')
export const growth320 = narrow(320, 'growth')
export const longLeadIn360 = narrow(360, 'coverage')
const WITH_PAUSED_GROWTH: Member[] = [
  ...MEMBERS,
  {
    name: 'Growth Bot',
    icon: <BotAvatarTile src={null} fallback="📈" className="size-4.5 shrink-0" />,
    detail: 'Runs growth experiments.',
    unavailable: 'Paused'
  }
]
export const pausedNameGrowth = defineFixture({
  width: 560,
  render: () => <MentionPicker query="growth" members={WITH_PAUSED_GROWTH} />
})
const GROUP: Member[] = [
  ...MEMBERS.filter((member) =>
    ['Eng - Nell', 'Compass', 'Garden', 'Planner'].includes(member.name)
  ).map(({ detail: _detail, ...member }) => member),
  { name: 'everyone', icon: <span className="size-4 shrink-0" /> }
]
export const groupRoomBareAt = defineFixture({
  width: 560,
  render: () => <MentionPicker query="" members={GROUP} withFiles={false} />
})
export const largestText = defineFixture({
  width: 560,
  render: () => <MentionPicker query="eng" textSize={20} />
})
export const bareAtLargestText = defineFixture({
  width: 560,
  render: () => <MentionPicker query="" textSize={20} />
})
export const reviewLargestText = defineFixture({
  width: 560,
  render: () => <MentionPicker query="review" textSize={20} />
})
export const growth360LargestText = defineFixture({
  width: 360,
  render: () => <MentionPicker query="growth" textSize={20} />
})
const CJK_MEMBERS: Member[] = [
  {
    name: 'Critic',
    icon: <BotAvatarTile src={null} fallback="🔎" className="size-4.5 shrink-0" />,
    detail: '负责整理团队所有日常代码审查和发布说明 documentation'
  }
]
export const cjkPurposeLargestText = defineFixture({
  width: 360,
  render: () => <MentionPicker query="审查" members={CJK_MEMBERS} textSize={20} />
})
const GREEK_MEMBERS: Member[] = [
  ...MEMBERS,
  {
    name: 'ΝΙΚΟΣ',
    icon: <BotAvatarTile src={null} fallback="🏛️" className="size-4.5 shrink-0" />,
    detail: 'ΕΛΕΓΧΟΣ κώδικα και σχεδίου για την ομάδα.'
  }
]
// Greek folds by whole-string casing, so the final sigma in ΝΙΚΟΣ matches a typed ς or σ.
export const greekName = defineFixture({
  width: 560,
  render: () => <MentionPicker query="νικος" members={GREEK_MEMBERS} />
})
