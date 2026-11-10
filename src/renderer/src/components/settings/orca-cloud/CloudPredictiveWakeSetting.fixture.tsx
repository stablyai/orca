import { defineFixture } from '../../../component-fixtures/component-fixture'
import { CloudPredictiveWakeSettingView } from './CloudPredictiveWakeSetting'

const noop = (): void => {}

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="max-w-2xl bg-background p-6">{children}</div>
}

export const on = defineFixture({
  width: 720,
  render: () => (
    <Frame>
      <CloudPredictiveWakeSettingView enabled idleMinutes={15} onToggle={noop} />
    </Frame>
  )
})

export const off = defineFixture({
  width: 720,
  render: () => (
    <Frame>
      <CloudPredictiveWakeSettingView enabled={false} idleMinutes={1} onToggle={noop} />
    </Frame>
  )
})
