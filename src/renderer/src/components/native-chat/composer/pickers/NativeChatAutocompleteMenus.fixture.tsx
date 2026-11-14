import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'

function CommandMenu({ invertedAccent = false }: { invertedAccent?: boolean }) {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4 pt-40"
      style={{
        ...nativeChatAppearanceStyle({}),
        ...(invertedAccent
          ? { '--accent': 'var(--foreground)', '--accent-foreground': 'var(--background)' }
          : {})
      }}
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
            skillsEnabled: true,
            skillStatus: 'ready',
            items: [
              {
                kind: 'command',
                id: 'compact',
                name: 'compact',
                token: '/compact',
                description: 'Summarize conversation context',
                argumentHint: '<instructions>',
                skillCollision: false
              },
              {
                kind: 'command',
                id: 'clear',
                name: 'clear',
                token: '/clear',
                description: 'Clear conversation context',
                skillCollision: false
              },
              {
                kind: 'skill',
                id: 'skill:demo',
                name: 'demo',
                token: '/demo',
                description: 'Plan or implement a change',
                argumentHint: '[plan|implement] [ref ...]',
                sources: []
              }
            ]
          }}
          activeIndex={0}
          listboxId="command-menu"
          onChoose={() => {}}
          onRetry={() => {}}
        />
      </div>
    </div>
  )
}

export const standard = defineFixture({ width: 560, render: () => <CommandMenu /> })

export const invertedAccent = defineFixture({
  width: 560,
  render: () => <CommandMenu invertedAccent />
})
