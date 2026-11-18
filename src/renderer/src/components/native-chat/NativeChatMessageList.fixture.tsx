import { useCallback, useMemo, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Button } from '../ui/button'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from './appearance/native-chat-appearance-style'
import type { NativeChatLiveSession } from './session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

const messages: NativeChatMessage[] = Array.from({ length: 940 }, (_, index) => {
  const id = `history-${index}`
  const text = `AUDIT row ${String(index).padStart(6, '0')}`
  return {
    id,
    timestamp: 1_800_000_000_000 + index * 1_000,
    source: 'transcript',
    role: index % 8 === 0 ? 'user' : 'assistant',
    blocks:
      index % 8 === 0 || index % 8 === 7
        ? [{ type: 'text', text: `${text}\n\n${'History content.\n\n'.repeat(1 + (index % 5))}` }]
        : [
            {
              type: 'tool-call',
              callId: id,
              name: 'Bash',
              state: 'completed',
              input: { command: `cat file-${index}.log` }
            },
            { type: 'tool-result', callId: id, output: `${text}\n${'Output line\n'.repeat(400)}` }
          ]
  }
})

function HistoryFrame({ fontSize }: { fontSize: number }): React.JSX.Element {
  const [history, setHistory] = useState({ start: 603, end: 900, revision: 0, generation: 0 })
  const [visible, setVisible] = useState(true)
  const prepend = useCallback(async (): Promise<'applied'> => {
    setHistory((current) => ({
      ...current,
      start: Math.max(0, current.start - 200),
      revision: current.revision + 1
    }))
    return 'applied'
  }, [])
  const session = useMemo<NativeChatLiveSession>(
    () => ({
      agent: 'claude',
      sessionId: 'history-fixture',
      status: 'ready',
      readPhase: 'ready',
      readCurrent: true,
      messages: messages.slice(history.start, history.end),
      hasMore: history.start > 0,
      loadingEarlier: false,
      olderHistoryGeneration: history.generation,
      prependRevision: history.revision,
      initialHistoryAutoLoad: false,
      loadEarlier: prepend
    }),
    [prepend, history]
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            setHistory((current) => ({
              ...current,
              start: Math.max(0, current.start - 200),
              end: Math.min(messages.length, current.end + 1),
              revision: current.revision + 1
            }))
          }
        >
          Prepend and append
        </Button>
        <Button size="sm" onClick={() => setVisible((current) => !current)}>
          {visible ? 'Hide transcript' : 'Show transcript'}
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setHistory((current) => ({
              ...current,
              end: Math.min(messages.length, current.end + 1)
            }))
          }
        >
          Append only
        </Button>
        <Button
          size="sm"
          onClick={() =>
            setHistory((current) => ({
              start: 603,
              end: 900,
              revision: 0,
              generation: current.generation + 1
            }))
          }
        >
          Reset history
        </Button>
      </div>
      <div
        className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} flex h-[700px] flex-col ${visible ? '' : 'hidden'}`}
        style={nativeChatAppearanceStyle({
          theme: 'dark',
          nativeChatAppearance: { fontSize, matchTerminalInterface: false }
        })}
      >
        <NativeChatMessageList
          session={session}
          isVisible={visible}
          isWorking={false}
          expandSignal={false}
        />
      </div>
    </div>
  )
}

function historyFixture(width: number, fontSize: number) {
  return defineFixture({
    width,
    setup: () => {
      Object.defineProperty(window, 'IntersectionObserver', {
        value: undefined,
        configurable: true
      })
    },
    render: () => <HistoryFrame fontSize={fontSize} />
  })
}

export const narrowSmall = historyFixture(600, 12)
export const narrowLarge = historyFixture(600, 20)
export const wideSmall = historyFixture(1280, 12)
export const wideLarge = historyFixture(1280, 20)
