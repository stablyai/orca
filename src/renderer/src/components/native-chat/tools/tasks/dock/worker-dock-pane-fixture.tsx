import { useEffect, useRef, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { NativeChatDock } from '../../../pane/dock/NativeChatDock'
import { NativeChatQuestionCard } from '../../../prompts/NativeChatQuestionCard'
import { NativeChatQueuedMessageList } from '../../../queue/NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from '../../../queue/use-structured-agent-session-queued-messages'
import {
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS,
  nativeChatAppearanceStyle,
  nativeChatTranscriptOuterClass
} from '../../../appearance/native-chat-appearance-style'
import { NativeChatJumpToLatest } from '../../../viewport/scroll/NativeChatJumpToLatest'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'

// Dev-only: the chat pane the worker dock fixtures render their strip in.
/** The strip in a full-height chat pane above a message box, as a chat shows it. */
const queue: StructuredAgentSessionQueuedMessagesController = {
  cards: [
    {
      messageId: 'fixture-queued',
      position: 0,
      state: 'waiting',
      hold: 'turn',
      text: 'Check the release notes.'
    }
  ],
  queueCapable: true,
  holds: () => false,
  agentMail: [],
  agentMailEditable: () => false,
  mailLeads: false,
  stopping: false,
  clearCapable: true,
  pause: null,
  resume: async () => true,
  clear: async () => true,
  queuePending: null,
  pending: () => null,
  steer: async () => {},
  remove: async () => {},
  editCapable: false,
  editor: undefined,
  edit: async () => {},
  steerHead: undefined,
  isWorking: true
}

// The chat's own transcript end padding and Jump to latest, so the pill's clearance is real.
function FixtureTranscript() {
  const [away, setAway] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // Starts at the end once the pill has reserved its room, as a following reader rests.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = scroller.current
      if (element) {
        element.scrollTop = element.scrollHeight
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        data-fixture-transcript=""
        className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget
          setAway(element.scrollTop + element.clientHeight < element.scrollHeight - 4)
        }}
      >
        <div className={nativeChatTranscriptOuterClass(false)}>
          <div className={`${NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS} text-sm text-chat-foreground`}>
            {Array.from({ length: 30 }, (_, index) => (
              <p key={index}>
                Transcript line {index + 1}: the coordinator reports on its workers.
              </p>
            ))}
            <p data-fixture-last-line="">Last line: every worker has reported in.</p>
          </div>
        </div>
      </div>
      <NativeChatJumpToLatest
        visible={away}
        onJump={() => {
          const element = scroller.current
          if (element) {
            element.scrollTop = element.scrollHeight
          }
        }}
      />
    </div>
  )
}

export function workerDockFixturePane(
  strip: React.ReactNode,
  sections?: 'question' | 'queue' | 'both'
) {
  return (
    <div
      data-native-chat-root=""
      className="native-chat-appearance flex h-[calc(100vh-2rem)] flex-col bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <FixtureTranscript />
      <Toaster />
      <NativeChatDock>
        <NativeChatWorkerDockFrame>{strip}</NativeChatWorkerDockFrame>
        {sections === 'question' || sections === 'both' ? (
          <NativeChatQuestionCard
            prompt={{
              questions: [
                {
                  header: 'Release notes',
                  question: 'Which change should the release notes lead with?',
                  multiSelect: false,
                  options: [
                    {
                      label: 'Worker reliability',
                      description: 'Show the active work and recent failures.'
                    },
                    {
                      label: 'Composer layout',
                      description: 'Highlight changes to the message box.'
                    }
                  ]
                }
              ]
            }}
            onAnswer={() => {}}
            onCancel={() => {}}
          />
        ) : null}
        {sections === 'queue' || sections === 'both' ? (
          <NativeChatQueuedMessageList controller={queue} chatWorktreeId={null} />
        ) : null}
        <div data-native-chat-composer-scope="fixture" className="shrink-0 px-3 pt-2 pb-4 sm:px-4">
          <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs">
            <textarea
              data-fixture-composer=""
              data-native-chat-prompt-editor="true"
              aria-label="Message"
              className="block min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm text-chat-foreground outline-none"
              defaultValue=""
              placeholder="Ask anything, / for commands, @ for context"
            />
          </div>
        </div>
      </NativeChatDock>
    </div>
  )
}
