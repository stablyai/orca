import { useRef } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { BrowserPageContextMenuItems } from './browser-page-context-menu-items'

// Panel classes mirror BrowserPageContextMenu without its fixed-position portal and backdrop.
const MENU_PANEL_CLASS =
  'min-w-[13rem] rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:text-white dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]'

// Right-clicked on a link inside a page in Orca's browser.
function BrowserPageLinkContextMenu(): React.JSX.Element {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  return (
    <div role="menu" aria-orientation="vertical" className={`w-max ${MENU_PANEL_CLASS}`}>
      <BrowserPageContextMenuItems
        menu={{
          x: 0,
          y: 0,
          pagePoint: { x: 0, y: 0 },
          linkUrl: 'https://github.com/stablyai/orca/pull/1234',
          pageUrl: 'https://github.com/stablyai/orca/pulls',
          selectionText: '',
          editable: null,
          image: null
        }}
        browserPageId="fixture-browser-page"
        worktreeId="fixture-worktree"
        canGoBack
        canGoForward={false}
        webviewRef={webviewRef}
        onReload={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}

export const linkMenu = defineFixture({
  width: 320,
  store: {
    installedBrowsers: [
      { id: 'com.google.Chrome', name: 'Google Chrome' },
      { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
      { id: 'com.apple.Safari', name: 'Safari' }
    ]
  },
  render: () => <BrowserPageLinkContextMenu />
})
