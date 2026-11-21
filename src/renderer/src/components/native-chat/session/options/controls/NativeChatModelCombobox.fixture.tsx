import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type {
  SessionOptionsCliUpdate,
  SessionOptionSelectChoice
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'

const claudeChoices: SessionOptionSelectChoice[] = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', legacy: true }
]
const codexChoices: SessionOptionSelectChoice[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
  { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
  { value: 'gpt-6-sol', label: 'GPT-6-Sol', legacy: true }
]

const noop = () => {}
const claudeUpdate = (
  phase: SessionOptionsCliUpdate['phase'],
  runnable = true
): SessionOptionsCliUpdate => ({
  agent: 'claude',
  models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', minVersion: '2.1.280' }],
  runnable,
  phase,
  start: noop,
  openFailure: noop
})
const codexUpdate = (
  phase: SessionOptionsCliUpdate['phase'],
  runnable = true
): SessionOptionsCliUpdate => ({
  agent: 'codex',
  models: [
    { id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', minVersion: '0.169.1' },
    { id: 'gpt-6.2-astra', name: 'GPT-6.2-Astra', minVersion: '0.169.1' }
  ],
  runnable,
  phase,
  start: noop,
  openFailure: noop
})

function picker(
  choices: SessionOptionSelectChoice[],
  cliUpdate: SessionOptionsCliUpdate,
  interact?: (frame: HTMLElement) => Promise<void>
) {
  return defineFixture({
    width: 340,
    render: () => (
      <div className="native-chat-appearance rounded-md border bg-popover p-1 text-popover-foreground">
        <NativeChatModelCombobox
          choices={choices}
          currentValue={choices[0].value}
          readOnly={false}
          readOnlyReason={null}
          busy={false}
          onSelect={noop}
          cliUpdate={cliUpdate}
        />
      </div>
    ),
    ...(interact ? { interact } : {})
  })
}

async function hoverModelName(frame: HTMLElement): Promise<void> {
  const name = frame.querySelector('[cmdk-item][data-value^="cli-update:"] span')
  name?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
  await new Promise((resolve) => setTimeout(resolve, 900))
}

export const claudeTooOld = picker(claudeChoices, claudeUpdate('idle'))
export const claudeUpdating = picker(claudeChoices, claudeUpdate('running'))
export const claudeUpdateFailed = picker(claudeChoices, claudeUpdate('failed'))
export const claudeTooOldTooltip = picker(claudeChoices, claudeUpdate('idle'), hoverModelName)
export const codexTooOld = picker(codexChoices, codexUpdate('idle'))
export const codexUpdating = picker(codexChoices, codexUpdate('running'))
export const codexUpdateFailed = picker(codexChoices, codexUpdate('failed'))
export const codexManualUpdate = picker(codexChoices, codexUpdate('idle', false))
export const codexTooOldTooltip = picker(codexChoices, codexUpdate('idle'), hoverModelName)
