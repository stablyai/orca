import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { SessionOptionsCliUpdate } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

const choices = [
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 4.5', legacy: true },
  { value: 'opus-4', label: 'Opus 4.1', legacy: true }
] as const

function picker(cliUpdate: SessionOptionsCliUpdate) {
  return defineFixture({
    width: 384,
    render: () => (
      <div className="native-chat-appearance rounded-md border bg-popover p-1 text-popover-foreground">
        <NativeChatModelCombobox
          choices={choices}
          currentValue="opus"
          readOnly={false}
          readOnlyReason={null}
          busy={false}
          onSelect={() => {}}
          cliUpdate={cliUpdate}
        />
      </div>
    )
  })
}

export const claudeUpdate = picker({ agent: 'claude', phase: 'idle', start: () => {} })
export const claudeUpdating = picker({ agent: 'claude', phase: 'running', start: () => {} })
export const codexUpdateFailed = picker({ agent: 'codex', phase: 'failed', start: () => {} })
