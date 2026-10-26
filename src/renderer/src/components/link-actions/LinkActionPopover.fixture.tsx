import { defineFixture } from '../../component-fixtures/component-fixture'
import { buildHttpLinkActions } from '@/lib/http-link-destinations'
import { useAppStore } from '@/store'
import { LinkActionPopover } from './LinkActionPopover'
import type { LinkActionRequest } from './link-action-request'

const ANCHOR_X = 24
const ANCHOR_Y = 150

// Default routing (Link Routing off): system browser primary, Orca Browser alternate.
const urlRequest: LinkActionRequest = {
  anchorX: ANCHOR_X,
  anchorY: ANCHOR_Y,
  destination: 'https://github.com/stablyai/orca/pull/1234',
  kind: 'url',
  ...buildHttpLinkActions({ primary: 'system', alternate: 'orca' }, () => {}),
  restoreFocus: () => {}
}

// Left-clicked a URL in terminal or chat output.
export const urlLink = defineFixture({
  width: 380,
  render: () => (
    <div className="h-[150px]">
      <LinkActionPopover request={urlRequest} onClose={() => {}} />
    </div>
  )
})

// Same click with Microsoft Edge chosen as the default browser.
export const urlLinkConfiguredBrowser = defineFixture({
  width: 380,
  store: {
    installedBrowsers: [{ id: 'com.microsoft.edgemac', name: 'Microsoft Edge' }]
  },
  setup: () => {
    const { settings } = useAppStore.getState()
    useAppStore.setState({
      settings: settings && { ...settings, externalBrowserId: 'com.microsoft.edgemac' }
    })
  },
  render: () => (
    <div className="h-[150px]">
      <LinkActionPopover
        request={{
          ...urlRequest,
          ...buildHttpLinkActions({ primary: 'system', alternate: 'orca' }, () => {})
        }}
        onClose={() => {}}
      />
    </div>
  )
})
