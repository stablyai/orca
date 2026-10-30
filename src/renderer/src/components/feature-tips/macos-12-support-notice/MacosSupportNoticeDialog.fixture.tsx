import { defineFixture } from '../../../component-fixtures/component-fixture'
import { MacosSupportNoticeDialog } from './MacosSupportNoticeDialog'
import FeatureTipsModal from '../FeatureTipsModal'

export const upgrade = defineFixture({
  width: 720,
  render: () => (
    <MacosSupportNoticeDialog
      open
      support={{ macos13: 'supported', modelIdentifier: null }}
      onOpenChange={() => {}}
      onOpenUrl={() => {}}
    />
  )
})

export const omarchy = defineFixture({
  width: 720,
  render: () => (
    <MacosSupportNoticeDialog
      open
      support={{ macos13: 'unsupported', modelIdentifier: 'MacBookPro13,3' }}
      onOpenChange={() => {}}
      onOpenUrl={() => {}}
    />
  )
})

export const unknown = defineFixture({
  width: 390,
  render: () => (
    <MacosSupportNoticeDialog open support={null} onOpenChange={() => {}} onOpenUrl={() => {}} />
  )
})

export const connected = defineFixture({
  store: {
    activeModal: 'feature-tips',
    modalData: { tipId: 'macos-12-support', source: 'app_open' },
    featureTipsSeenIds: ['macos-12-support']
  },
  setup: () => {
    const platform = window.api.platform.get()
    window.api.platform.get = () => ({ ...platform, platform: 'darwin', osRelease: '12.7.6' })
    window.api.app.getMacosUpgradeSupport = () =>
      Promise.resolve({ macos13: 'unsupported', modelIdentifier: 'MacBookPro13,3' })
    window.api.shell.openUrl = (url) => {
      document.documentElement.dataset.macosGuideUrl = url
      return Promise.resolve()
    }
  },
  render: () => <FeatureTipsModal />
})

export const connectedUpgrade = defineFixture({
  ...connected,
  setup: () => {
    connected.setup?.()
    window.api.app.getMacosUpgradeSupport = () =>
      Promise.resolve({ macos13: 'supported', modelIdentifier: null })
  }
})

export const connectedOlderClient = defineFixture({
  ...connected,
  setup: () => {
    connected.setup?.()
    delete window.api.app.getMacosUpgradeSupport
  }
})
