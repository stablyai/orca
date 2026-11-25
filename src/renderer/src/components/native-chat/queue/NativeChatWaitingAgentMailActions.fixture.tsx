import { defineFixture } from '../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { createMembershipStore } from '../../../../../shared/collections/membership-store'
import {
  NativeChatWaitingAgentMailActions,
  NativeChatWaitingAgentMailContext,
  type NativeChatWaitingAgentMail
} from './NativeChatWaitingAgentMailActions'

const noop = async (): Promise<void> => {}

const actions: NativeChatWaitingAgentMail = {
  steer: noop,
  remove: noop,
  edit: noop,
  pending: () => null,
  isWorking: true,
  steerHeld: false,
  editable: createMembershipStore((id) => id === 'editable')
}

// The waiting row's Steer, Edit and Delete keep the queued row's even glyph spacing.
function Actions({ fontSize }: { fontSize?: number }) {
  return (
    <NativeChatWaitingAgentMailContext.Provider value={actions}>
      <div
        className="native-chat-appearance flex flex-col items-end gap-2 p-3 text-sm"
        style={nativeChatAppearanceStyle(fontSize ? { nativeChatAppearance: { fontSize } } : {})}
      >
        <NativeChatWaitingAgentMailActions queuedMessageId="editable" />
        <NativeChatWaitingAgentMailActions queuedMessageId="fixed" />
      </div>
    </NativeChatWaitingAgentMailContext.Provider>
  )
}

export const editableAndNot = defineFixture({ width: 200, render: () => <Actions /> })

// The smallest text size shrinks the chat's spacing unit; the flush buttons keep 24px targets.
export const smallestText = defineFixture({ width: 200, render: () => <Actions fontSize={12} /> })
