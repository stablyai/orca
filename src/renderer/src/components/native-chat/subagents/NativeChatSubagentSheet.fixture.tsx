import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../../shared/native-chat/native-chat-types'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from '../appearance/native-chat-appearance-style'
import { NativeChatApprovalCard } from '../prompts/NativeChatApprovalCard'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'
import { openNativeChatSubagent } from './native-chat-open-subagent'
import {
  NativeChatSubagentSheetLayer,
  NativeChatSubagentSheetPromptSlot
} from './NativeChatSubagentSheetLayer'
import { NativeChatSubagentTranscripts } from './NativeChatSubagentTranscripts'

const T0 = Date.now() - 300_000
const PROMPT =
  'Read-only investigation, thoroughness: very thorough. Report file:line evidence; mark unverified claims.\n\nContext: the desktop app can show browser pages of a remote runtime as a streamed screencast; the page itself lives on the remote host. Locally, element-grab annotation uses main-process code.\n\nFind every place the annotate button decides whether it is enabled.'

type State = NativeChatSubagentEntry['state']

function agents(state: State): NativeChatSubagentEntry[] {
  const settled = state === 'working' ? {} : { settledAt: T0 + 240_000 }
  return [
    {
      id: 'a1',
      label: 'Map streamed remote page RPC',
      state,
      tokens: 191_300,
      startedAt: T0,
      agentType: 'Explore',
      ...settled,
      ...(state === 'completed'
        ? {
            lastMessage:
              'Annotation runs only in the local main process (`browser-core.ts:212`). The remote page never gets the grab hooks, so the button stays disabled on remote hosts.'
          }
        : state === 'failed'
          ? { lastMessage: 'Remote host refused the RPC (403). No reply.' }
          : {})
    },
    { id: 'a2', label: 'Find annotate entry points', state: 'working', startedAt: T0 },
    { id: 'a3', label: 'Check remote auth', state: 'completed', startedAt: T0, settledAt: T0 }
  ]
}

function row(id: string, agentId: string, blocks: NativeChatMessage['blocks'], parent?: string) {
  return {
    id,
    role: 'assistant' as const,
    source: 'transcript' as const,
    timestamp: T0 + 1_000,
    agentId,
    ...(parent ? { parentAgentId: parent } : {}),
    blocks
  }
}

function bash(command: string, output: string): NativeChatMessage['blocks'] {
  return [
    { type: 'tool-call', name: 'Bash', input: { command }, state: 'completed' },
    { type: 'tool-result', output }
  ]
}

function session(state: State): NativeChatLiveSession {
  const messages: NativeChatMessage[] = [
    {
      id: 'ask',
      role: 'user',
      source: 'transcript',
      timestamp: T0 - 2_000,
      blocks: [{ type: 'text', text: "Why can't I annotate pages on a remote host? Investigate." }]
    },
    {
      id: 'plan',
      role: 'assistant',
      source: 'transcript',
      timestamp: T0 - 1_000,
      blocks: [
        {
          type: 'text',
          text: "I'll split this up: one agent maps the streamed page RPC, one finds the annotate entry points, one checks auth on the remote host."
        },
        {
          type: 'tool-call',
          name: 'spawn_agent',
          input: { prompt: PROMPT, agents: ['a1'] },
          state: 'completed'
        },
        { type: 'subagent-group', groupId: 'turn-1', agents: agents(state) }
      ]
    },
    row('a1-1', 'a1', bash('rg -n "annotate" src', 'src/browser-core.ts:212: annotate()')),
    row('a1-2', 'a1', [{ type: 'text', text: 'Now the renderer call path `callRuntimeRpc`.' }]),
    row('a1-3', 'a1', bash('rg -n callRuntimeRpc src/renderer', '41 matches')),
    row('a1-4', 'a1', [
      { type: 'text', text: 'Now browser-core.ts (navigation/input methods).' },
      {
        type: 'subagent-group',
        groupId: 'a1-turn',
        agents: [
          {
            id: 'a4',
            label: 'Trace grab hook wiring',
            state: 'working',
            tokens: 12_400,
            startedAt: T0 + 60_000,
            agentType: 'Explore'
          }
        ]
      }
    ]),
    row('a4-1', 'a4', [{ type: 'text', text: 'Checking the grab hook wiring.' }], 'a1')
  ]
  return {
    messages,
    agent: 'codex',
    sessionId: 'subagent-sheet-fixture',
    status: 'ready',
    readPhase: 'ready',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'applied'
  }
}

function Pane({
  paneKey,
  state = 'working',
  waiting,
  tallPrompt = false,
  height = 620
}: {
  paneKey: string
  state?: State
  waiting?: string | null
  /** The waiting approval carries a long plan, as a plan approval does. */
  tallPrompt?: boolean
  height?: number
}) {
  return (
    <div
      data-native-chat-root="true"
      tabIndex={-1}
      className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} relative flex flex-col overflow-hidden`}
      style={{ ...nativeChatAppearanceStyle({}), height }}
    >
      <NativeChatSubagentSheetLayer
        paneKey={paneKey}
        sessionKey="fixture"
        waiting={waiting}
        stop={
          state === 'working' ? (
            <Button type="button" variant="outline" size="xs">
              Stop
            </Button>
          ) : undefined
        }
      >
        <NativeChatSubagentTranscripts
          paneKey={paneKey}
          find={{ isOpen: false, query: '' }}
          session={session(state)}
          isWorking={state === 'working'}
          expandSignal={false}
        />
        {waiting === undefined ? null : (
          <NativeChatSubagentSheetPromptSlot agentId={waiting ?? undefined}>
            <NativeChatApprovalCard
              approval={{
                ...(tallPrompt
                  ? {
                      detail: Array.from(
                        { length: 30 },
                        (_, step) => `${step + 1}. Read and map the grab hook call site ${step + 1}`
                      ).join('\n')
                    }
                  : {}),
                title: 'Allow curl -s localhost:9222/json?',
                options: [
                  { label: 'Allow', send: 'accept' },
                  { label: 'Deny', send: 'decline' }
                ]
              }}
              onChoose={() => {}}
            />
          </NativeChatSubagentSheetPromptSlot>
        )}
        <div className="shrink-0 px-4 pt-2 pb-4">
          <div
            data-native-chat-prompt-editor
            tabIndex={0}
            className="mx-auto h-16 max-w-(--chat-content-max-width) rounded-lg border border-chat-composer-border bg-chat-composer-surface p-3 text-sm text-chat-foreground-faint"
          >
            Ask anything…
          </div>
        </div>
      </NativeChatSubagentSheetLayer>
    </div>
  )
}

function sheet(
  name: string,
  props: Omit<React.ComponentProps<typeof Pane>, 'paneKey'> & {
    width?: number
    agentId?: string
  } = {}
) {
  const { width = 560, agentId = 'a1', ...pane } = props
  const paneKey = `fixture:${name}`
  return defineFixture({
    width,
    setup: () => openNativeChatSubagent(paneKey, agentId),
    render: () => <Pane paneKey={paneKey} {...pane} />
  })
}

export const closed = defineFixture({
  width: 560,
  render: () => <Pane paneKey="fixture:closed" />
})
export const working = sheet('working')
export const working360 = sheet('working360', { width: 360 })
export const working1000 = sheet('working1000', { width: 1000 })
export const shortPane = sheet('short', { height: 380 })
export const completed = sheet('completed', { state: 'completed' })
export const failed = sheet('failed', { state: 'failed' })
export const stopped = sheet('stopped', { state: 'stopped' })
export const needsYouHere = sheet('needsYouHere', { waiting: 'a1', width: 1000 })
export const needsYouHere360 = sheet('needsYouHere360', { waiting: 'a1', width: 360 })
export const needsYouHere560 = sheet('needsYouHere560', { waiting: 'a1' })
export const shortPaneTallApproval = sheet('shortTall', {
  waiting: 'a1',
  tallPrompt: true,
  height: 380
})
export const mainNeedsYou = sheet('mainNeedsYou', { waiting: null })
export const otherNeedsYou = sheet('otherNeedsYou', { waiting: 'a2' })
export const nested = sheet('nested', { agentId: 'a4' })
export const nestedMenu = defineFixture({
  ...sheet('nestedMenu', { agentId: 'a4' }),
  interact: async (frame) => {
    // Open the menu once the sheet has slid in, as a person would.
    await new Promise((resolve) => setTimeout(resolve, 400))
    frame
      .querySelector('[role="dialog"] [aria-haspopup="menu"]')
      ?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
