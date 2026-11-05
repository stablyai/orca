import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatSettingsButton } from './NativeChatSettingsButton'
import { useAppStore } from '../../store'

export const menu = defineFixture({
  width: 320,
  render: () => (
    <div
      className="pane-title-overlay-layer h-48 bg-background p-2"
      data-pane-title-surface={
        useAppStore.getState().settings?.theme === 'light' ? 'light' : 'dark'
      }
      style={{ position: 'relative' }}
    >
      <div className="pane-title-bar" data-active-pane="" data-chromeless="">
        <div className="pane-title-actions ml-auto">
          <NativeChatSettingsButton />
        </div>
      </div>
    </div>
  ),
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})
