import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'
import { NativeChatFileLinkExistenceContext } from './native-chat-file-link-existence'
import { NativeChatLinkClickContext } from './native-chat-link-click-context'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

const send: NativeChatInteractiveSend = {
  sendAnswer: () => ({ settleAfterMs: 0 }),
  sendRaw: () => {},
  sendRawVerified: async () => true,
  cancelPending: () => {},
  cancelAsk: async () => true,
  cancel: () => {}
}

const linkSnapshot = {
  check: (link: { pathText: string }) =>
    link.pathText === 'src/main/pi/omp-plan-review-source.ts' ||
    link.pathText === '/tmp/plan-mock.html',
  peek: () => false
}

const linkExistence = {
  watch: () => ({ subscribe: () => () => {}, getSnapshot: () => linkSnapshot }),
  recheck: () => {}
}

const preventLinkDefault = (event: { preventDefault: () => void }): void => event.preventDefault()

// A terminal-backed plan review: the card the terminal view shows above the composer.
export const terminalPlanLinks = defineFixture({
  width: 720,
  render: () => (
    <NativeChatFileLinkExistenceContext.Provider value={linkExistence}>
      <NativeChatLinkClickContext value={preventLinkDefault}>
        <div
          className="native-chat-appearance bg-chat-canvas p-4"
          style={nativeChatAppearanceStyle({})}
        >
          <NativeChatInteractiveCard
            card={{
              kind: 'approval',
              approval: {
                title: 'Review proposed plan',
                description: 'Refine plan closes the review so you can send what to change.',
                subject: {
                  kind: 'plan',
                  text: '## Plan\n\n1. Read src/main/pi/omp-plan-review-source.ts and keep the plan text verbatim.\n2. Show the mock at /tmp/plan-mock.html before building.\n3. Leave src/missing/file.ts alone.'
                },
                options: [
                  { label: 'Approve', send: 'approve' },
                  { label: 'Refine plan', send: 'refine' }
                ]
              }
            }}
            send={send}
            onDismiss={() => {}}
          />
        </div>
      </NativeChatLinkClickContext>
    </NativeChatFileLinkExistenceContext.Provider>
  )
})
