import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings, getDefaultVoiceSettings } from '../../../../shared/constants'
import { NativeChatVoicePanel, type NativeChatVoicePanelProps } from './NativeChatVoicePanel'
import { NativeChatVoiceSettings } from './NativeChatVoiceSettings'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'

const options: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    settable: true,
    valueSource: 'applied',
    transport: 'agent-session',
    kind: {
      type: 'select',
      currentValue: 'gpt-6-luna',
      choices: [{ value: 'gpt-6-luna', label: 'GPT-6-Luna' }]
    }
  },
  {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    settable: true,
    valueSource: 'applied',
    transport: 'agent-session',
    kind: {
      type: 'select',
      currentValue: 'low',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }
  }
]

const props: NativeChatVoicePanelProps = {
  modelLabel: 'Local AI turn detection · experimental',
  canSubmitSpoken: true,
  onSubmitSpoken: () => {},
  running: true,
  listening: true,
  speaking: true,
  stateLabel: 'Speaking · listening for you',
  startDisabled: false,
  canInterrupt: true,
  userCaption: 'Can we discuss this while I keep working in the chat?',
  assistantCaption:
    'Yes. Voice continues in your selected chat, and you can review the conversation history at any time.',
  notice: '',
  setupNeeded: false,
  retainedDraft: false,
  canRetry: false,
  onToggle: () => {},
  onInterrupt: () => {},
  onRetry: () => {},
  onDiscard: () => {}
}

function Panel(overrides: Partial<NativeChatVoicePanelProps>): React.JSX.Element {
  return (
    <div className="bg-sidebar text-sidebar-foreground">
      <div className="border-b border-border px-3 py-2 text-sm font-medium">Voice conversation</div>
      <NativeChatVoiceSettings
        voice={{
          ...getDefaultVoiceSettings(),
          sttModel: 'elevenlabs-scribe-v2-realtime',
          ttsProvider: 'elevenlabs'
        }}
        working={false}
        transport={{
          optionSnapshot: options,
          optionsSurface: {
            getSnapshot: () => options,
            subscribe: () => () => {},
            setOption: async () => ({ snapshot: options }),
            invokeAction: async () => ({ snapshot: options })
          }
        }}
      />
      <NativeChatVoicePanel {...props} {...overrides} />
    </div>
  )
}

export const speaking = defineFixture({
  width: 360,
  store: { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' } },
  render: () => <Panel />
})
export const narrow = defineFixture({ ...speaking, width: 280 })
export const listening = defineFixture({
  ...speaking,
  render: () => (
    <Panel
      listening
      speaking={false}
      canInterrupt={false}
      stateLabel="Listening"
      userCaption="In this project, we could"
    />
  )
})
export const setup = defineFixture({
  ...narrow,
  render: () => (
    <Panel
      running={false}
      listening={false}
      speaking={false}
      canInterrupt={false}
      startDisabled
      setupNeeded
      stateLabel="Ready"
      userCaption=""
      assistantCaption=""
    />
  )
})
