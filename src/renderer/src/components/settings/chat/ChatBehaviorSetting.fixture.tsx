import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { useAppStore } from '@/store/index'
import { ChatBehaviorSetting } from './ChatBehaviorSetting'

function ChatBehaviorPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  return settings ? (
    <div className="settings-view-shell p-8">
      <ChatBehaviorSetting
        settings={settings}
        updateSettings={(updates) =>
          useAppStore.setState({ settings: { ...settings, ...updates } })
        }
        forceVisible
      />
    </div>
  ) : null
}

export const enter = defineFixture({
  width: 760,
  store: { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' } },
  render: () => <ChatBehaviorPreview />
})
export const shiftEnter = defineFixture({
  width: 760,
  store: {
    settings: {
      ...getDefaultSettings('/home/fixture'),
      uiLanguage: 'en',
      nativeChatSendKey: 'shift-enter'
    }
  },
  render: () => <ChatBehaviorPreview />
})
export const narrow = defineFixture({
  width: 390,
  store: {
    settings: {
      ...getDefaultSettings('/home/fixture'),
      uiLanguage: 'en',
      nativeChatSendKey: 'shift-enter'
    }
  },
  render: () => <ChatBehaviorPreview />
})
