import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../store/index'
import { ChatBehaviorSetting } from './ChatBehaviorSetting'

function BehaviorSettings(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings!)
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <ChatBehaviorSetting
        settings={settings}
        updateSettings={(updates) =>
          useAppStore.setState({ settings: { ...settings, ...updates } })
        }
        forceVisible
      />
    </div>
  )
}

export const enterSends = defineFixture({
  width: 760,
  setup: () =>
    useAppStore.setState(({ settings }) => ({
      settings: { ...settings!, nativeChatPermissionMode: undefined }
    })),
  render: () => <BehaviorSettings />
})

export const enterInsertsNewline = defineFixture({
  ...enterSends,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('#chat-enter-to-send [role="switch"]')!.click()
  }
})

export const narrow = defineFixture({ ...enterInsertsNewline, width: 390 })
