import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import { withNativeChatResumeCommand } from './use-native-chat-resume-command'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'

function HookCommandMenu({ supported }: { supported: boolean }) {
  const commands = withNativeChatResumeCommand(
    [],
    true,
    false,
    (_key, fallback) => fallback ?? _key,
    supported
  )
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4 pt-64"
      style={nativeChatAppearanceStyle({})}
    >
      <div className="relative h-6">
        <NativeChatPickerMenu
          autocomplete={{
            mode: 'slash',
            query: '',
            triggerKey: '/:0',
            prefix: '/',
            dispatchable: true,
            grouped: false,
            commandsEnabled: true,
            skillsEnabled: false,
            skillStatus: 'ready',
            items: commands.map((command) => ({
              ...command,
              kind: 'command',
              id: command.name,
              token: `/${command.name}`,
              skillCollision: false
            }))
          }}
          activeIndex={0}
          listboxId="hook-command-menu"
          onChoose={() => {}}
          onRetry={() => {}}
        />
      </div>
    </div>
  )
}

export const unsupportedHost = defineFixture({
  width: 560,
  render: () => <HookCommandMenu supported={false} />
})
export const supportedHost = defineFixture({
  width: 560,
  render: () => <HookCommandMenu supported />
})
