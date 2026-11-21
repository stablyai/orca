import { defineFixture } from '../../../component-fixtures/component-fixture'
import { projectQueuedMessageCards } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from '../appearance/native-chat-appearance-style'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'

const [card] = projectQueuedMessageCards(
  [
    {
      messageId: 'queued-text-wrap',
      position: 1,
      state: 'waiting',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: `Review these items.\n${'X'.repeat(120)}` }]
      }
    }
  ],
  [],
  { agentWorking: true }
)

export const smallTextExpanded = defineFixture({
  width: 616,
  render: () => (
    <ul
      className={NATIVE_CHAT_APPEARANCE_ROOT_CLASS}
      style={nativeChatAppearanceStyle({
        terminalFontSize: 10,
        terminalFontFamily: 'monospace',
        nativeChatAppearance: { matchTerminalInterface: true }
      })}
    >
      <NativeChatQueuedMessageCard
        card={card!}
        chatWorktreeId={null}
        showsSteerShortcut
        agentWorking
        onSteer={() => {}}
        onDelete={() => {}}
        onEdit={() => {}}
      />
    </ul>
  ),
  interact: async (frame) => {
    const toggle = frame.querySelector<HTMLButtonElement>('button[aria-label="Show full message"]')
    const remove = frame.querySelector('button[aria-label="Delete"]')
    if (!toggle || !remove) {
      throw new Error('Expected a clipped queued message with row controls')
    }
    toggle.focus()
    toggle.click()
    await new Promise(requestAnimationFrame)

    const message = frame.ownerDocument.getElementById(toggle.getAttribute('aria-controls') ?? '')
    if (!message) {
      throw new Error('Expected the toggle to expand the queued message')
    }
    const range = frame.ownerDocument.createRange()
    range.selectNodeContents(message)
    const [first, second] = Array.from(range.getClientRects()).filter((rect) => rect.width > 0)
    const actionBox = remove.getBoundingClientRect()
    if (!first || first.top >= actionBox.bottom) {
      throw new Error('The message should start beside its actions')
    }
    if (!second || second.right <= actionBox.right || second.top < actionBox.bottom) {
      throw new Error('The second line should use the width below the actions')
    }
  }
})
