import { useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import BrowserAddressBar from '../address-bar/BrowserAddressBar'
import { BrowserChromeToolbar } from '../toolbar/browser-chrome-toolbar'
import { CookiesImportedBanner } from './browser-page-chrome-banners'

const noop = (): void => {}

function ToolbarWithBanner({ count }: { count: number }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <BrowserChromeToolbar
        closeTabOwner={{ worktreeId: 'fixture', browserPageId: 'fixture-page' }}
        controls={{
          canGoBack: true,
          canGoForward: false,
          goBack: noop,
          goForward: noop,
          reload: noop,
          navigate: noop
        }}
        addressSlot={
          <BrowserAddressBar
            pageId="fixture-page"
            value="example.com"
            inputRef={inputRef}
            onChange={noop}
            onSubmit={noop}
            onNavigate={noop}
          />
        }
        elementTools={null}
        markup={{ active: false, disabled: false, onToggle: noop, canShowDiscoveryHint: false }}
        overflowMenu={() => null}
      />
      <CookiesImportedBanner count={count} onReloadPage={noop} onDismiss={noop} />
      <div className="h-16 bg-muted/30" />
    </div>
  )
}

export const imported = defineFixture({
  width: 640,
  render: () => <ToolbarWithBanner count={3694} />
})

export const importedOne = defineFixture({
  width: 640,
  render: () => <ToolbarWithBanner count={1} />
})

export const importedNarrow = defineFixture({
  width: 240,
  render: () => <ToolbarWithBanner count={128450} />
})
