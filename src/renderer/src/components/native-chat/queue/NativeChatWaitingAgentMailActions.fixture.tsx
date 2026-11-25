import { defineFixture } from '../../../component-fixtures/component-fixture'
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
function Actions() {
  return (
    <NativeChatWaitingAgentMailContext.Provider value={actions}>
      <div className="flex flex-col items-end gap-2 p-3 text-sm">
        <NativeChatWaitingAgentMailActions queuedMessageId="editable" />
        <NativeChatWaitingAgentMailActions queuedMessageId="fixed" />
      </div>
    </NativeChatWaitingAgentMailContext.Provider>
  )
}

export const editableAndNot = defineFixture({ width: 200, render: () => <Actions /> })
