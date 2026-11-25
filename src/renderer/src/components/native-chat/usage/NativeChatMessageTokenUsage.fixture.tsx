import { defineFixture } from '../../../component-fixtures/component-fixture'
import { MessageRow } from '../messages/rows/NativeChatMessageRow'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'

const message: NativeChatMessage = {
  id: 'answer-one',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: 'Updated the configuration and checked the result' }],
  usage: {
    inputTokens: 2_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 8_000,
    outputTokens: 250
  },
  usageContext: {
    used: {
      kind: 'report',
      model: 'unknown',
      usedTokens: 10_250,
      windowTokens: 256_000,
      percentage: 4,
      categories: [],
      capturedAt: 1
    }
  }
}

function answerFixture(width = 640, unknown = false, working = false) {
  return defineFixture({
    width,
    render: () => (
      <div className="native-chat-appearance space-y-4 bg-chat-pane p-4">
        <MessageRow
          message={unknown ? { ...message, usage: undefined, usageContext: undefined } : message}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
          activeTurnIsWorking={working}
          trailingRun={working}
        />
        {!working && !unknown ? (
          <MessageRow
            message={{
              ...message,
              id: 'answer-two',
              blocks: [{ type: 'text', text: 'The second response has its own token accounting' }],
              usage: {
                inputTokens: 4_000,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 8_000,
                outputTokens: 600
              }
            }}
            expandSignal={false}
            onScrollMessageToTop={() => {}}
          />
        ) : null}
      </div>
    )
  })
}

export const answers = answerFixture()
export const narrow = answerFixture(320)
export const unavailable = answerFixture(640, true)
export const streaming = answerFixture(640, false, true)
