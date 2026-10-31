import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { ChatBehaviorSetting } from './ChatBehaviorSetting'

function ChatBehaviorPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  return settings ? (
    <div className="bg-background p-4 text-foreground">
      <ChatBehaviorSetting
        settings={settings}
        updateSettings={(updates) =>
          useAppStore.setState((state) => ({
            settings: state.settings ? { ...state.settings, ...updates } : null
          }))
        }
        forceVisible
      />
    </div>
  ) : null
}

export const sideChatPane = defineFixture({
  width: 640,
  setup: () =>
    useAppStore.setState((state) => ({
      settings: state.settings ? { ...state.settings, nativeChatSideChatPane: true } : null
    })),
  render: () => <ChatBehaviorPreview />
})
