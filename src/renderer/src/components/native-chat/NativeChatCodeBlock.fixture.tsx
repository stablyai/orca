import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from './native-chat-visual-owner'

const OWNER: NativeChatVisualOwner = {
  target: { kind: 'local' },
  sessionId: 'fixture-session',
  worktreeId: 'fixture-repo::/work'
}

const PARAGRAPH = [
  'We minimize the expected latency of KV-cache delivery subject to a per-slot',
  'energy budget, and show that the optimal multicast schedule is a threshold',
  'policy on the readiness of each receiver.'
].join(String.fromCharCode(10))

function Block(): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      <NativeChatCodeBlock language="latex">
        <code>{PARAGRAPH}</code>
      </NativeChatCodeBlock>
    </NativeChatVisualOwnerContext.Provider>
  )
}

export const reading = defineFixture({ width: 640, render: () => <Block /> })

export const editing = defineFixture({
  width: 640,
  render: () => <Block />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[data-native-chat-code-edit]')?.click()
  }
})
