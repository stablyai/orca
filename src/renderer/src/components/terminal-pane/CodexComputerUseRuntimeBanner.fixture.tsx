import { defineFixture } from '../../component-fixtures/component-fixture'
import { CodexComputerUseRuntimeNotice } from './CodexComputerUseRuntimeBanner'

export const before = defineFixture({
  width: 640,
  render: () => <div className="relative h-44 bg-background" />
})

export const stale = defineFixture({
  width: 640,
  render: () => (
    <div className="relative h-44 bg-background">
      <CodexComputerUseRuntimeNotice
        explicitCommand={false}
        disabled={false}
        onRestart={() => {}}
        onDismiss={() => {}}
      />
    </div>
  )
})

export const waiting = defineFixture({
  width: 360,
  render: () => (
    <div className="relative h-52 bg-background">
      <CodexComputerUseRuntimeNotice
        explicitCommand={false}
        disabled
        message="Codex: waiting until it is idle"
        onRestart={() => {}}
        onDismiss={() => {}}
      />
    </div>
  )
})
