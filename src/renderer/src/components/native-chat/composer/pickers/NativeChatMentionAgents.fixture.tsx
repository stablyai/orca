// The `@` list in a coordinator chat: its bots above its crew's agents, then files.
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { BotAvatarTile } from '../../../bots/BotAvatar'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { NativeChatRoomContext } from '../../native-chat-room-context'
import { nativeChatMentionValue } from '../native-chat-composer-types'
import { crewAgentMentions } from '../../../orchestration-crew/native-chat-crew-mentions'
import { NativeChatMentionMenu } from './NativeChatAutocompleteMenus'

const { mentions: agents } = crewAgentMentions(
  {
    status: 'ok',
    sections: {
      managedBy: [],
      managing: [
        {
          partyKey: 'w1',
          role: 'worker',
          label: 'auth-tests',
          agentKind: 'codex',
          status: 'working',
          task: { title: 'Rewrite auth integration tests', state: 'dispatched' },
          sendAddress: 'term_w1'
        },
        {
          partyKey: 'w3',
          role: 'worker',
          label: 'perf-audit',
          agentKind: 'antigravity',
          status: 'waiting',
          task: { title: 'Profile token refresh under load', state: 'dispatched' },
          sendAddress: 'term_w3'
        }
      ],
      talkingWith: [
        {
          partyKey: 'p1',
          role: 'peer',
          label: 'release-bot',
          agentKind: 'claude',
          status: 'done',
          sendAddress: 'term_p1'
        }
      ]
    }
  },
  'local'
)

const bots = [
  {
    name: 'triage',
    id: 'triage',
    icon: (
      <BotAvatarTile
        src={null}
        fallback="🦉"
        className="mt-0.5 size-5 shrink-0 rounded-sm text-2xs"
      />
    ),
    detail: 'GitHub issues'
  }
]

const room = { replies: null, mentions: bots, withFiles: true, unavailable: [], agents }

export const botsAboveAgents = defineFixture({
  width: 560,
  render: () => (
    <div
      className="native-chat-appearance bg-chat-canvas p-4 pt-[260px]"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatRoomContext.Provider value={room}>
        <div className="relative">
          <NativeChatMentionMenu
            mention={{
              files: [
                ...bots.map(nativeChatMentionValue),
                ...agents.map(nativeChatMentionValue),
                'src/auth/session.ts'
              ],
              loading: false,
              failed: false
            }}
            activeIndex={0}
            listboxId="agents"
            onChoose={() => {}}
          />
          <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface px-3 py-3 text-sm">
            @
            <span className="ml-px inline-block h-4 w-px translate-y-0.5 bg-foreground" />
          </div>
        </div>
      </NativeChatRoomContext.Provider>
    </div>
  )
})
