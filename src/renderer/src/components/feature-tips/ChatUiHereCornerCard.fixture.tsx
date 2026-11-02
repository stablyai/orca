import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ChatUiHereCornerCard } from './ChatUiHereCornerCard'
import { LiveSwitchingDemo, LiveSwitchingDemoDialog } from './LiveSwitchingDemoDialog'

export const open = defineFixture({
  width: 360,
  store: {
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' })
  },
  render: () => <ChatUiHereCornerCard onClose={() => {}} />
})

export const liveSwitching = defineFixture({
  width: 360,
  store: {
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: 'terminal',
      telemetry: {
        optedIn: true,
        installId: 'install',
        existedBeforeTelemetryRelease: true,
        chatUiLaunchTipCohort: 'treatment-live-switch'
      }
    })
  },
  render: () => <ChatUiHereCornerCard onClose={() => {}} />
})

export const swappedButtons = defineFixture({
  width: 360,
  store: {
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: 'terminal',
      telemetry: {
        optedIn: true,
        installId: 'install',
        existedBeforeTelemetryRelease: true,
        chatUiLaunchTipCohort: 'treatment-swapped-buttons'
      }
    })
  },
  render: () => <ChatUiHereCornerCard onClose={() => {}} />
})

export const liveSwitchingDialog = defineFixture({
  width: 480,
  render: () => <LiveSwitchingDemoDialog open onOpenChange={() => {}} />
})

export const liveSwitchingDialogFromChat = defineFixture({
  width: 480,
  render: () => <LiveSwitchingDemoDialog open onOpenChange={() => {}} initialSurface="chat" />
})

export const liveSwitchingModes = defineFixture({
  width: 1200,
  setup: () => {
    document.documentElement.style.background = 'var(--background)'
    document.body.style.background = 'var(--background)'
  },
  render: () => (
    <div className="-m-4 grid grid-cols-2 gap-8 bg-background p-16">
      <LiveSwitchingDemo
        active={false}
        initialSurface="terminal"
        canvasClassName="h-[26rem] p-8"
        showSkeleton={false}
      />
      <LiveSwitchingDemo
        active={false}
        initialSurface="chat"
        canvasClassName="h-[26rem] p-8"
        showSkeleton={false}
      />
    </div>
  )
})
