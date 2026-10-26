import { useRef } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import TerminalContextMenu from './TerminalContextMenu'

const noop = (): void => {}

// Right-clicked on a URL printed in the terminal output.
function TerminalContextMenuOnLink(): React.JSX.Element {
  const menuOpenedAtRef = useRef(0)
  return (
    <div className="relative h-[560px] rounded-md bg-muted/40 p-3 font-mono text-xs">
      <span>PR created: </span>
      <span className="underline">https://github.com/stablyai/orca/pull/1234</span>
      <TerminalContextMenu
        open
        onOpenChange={noop}
        menuPoint={{ x: 120, y: 24 }}
        menuOpenedAtRef={menuOpenedAtRef}
        canClosePane
        canExpandPane
        menuPaneIsExpanded={false}
        onCopy={noop}
        onSelectAll={noop}
        onPaste={noop}
        onSplitRight={noop}
        onSplitDown={noop}
        keybindings={{}}
        canEqualizePaneSizes={false}
        onEqualizePaneSizes={noop}
        onClosePane={noop}
        onClearScreen={noop}
        onResetTerminal={noop}
        canContinueAgentSessionInNewSession={false}
        onContinueAgentSessionInNewSession={noop}
        onForkAgentSession={noop}
        canToggleNativeChat={false}
        isNativeChatView={false}
        onToggleNativeChat={noop}
        onCopyAgentSessionContext={noop}
        quickCommandHosts={[
          {
            hostId: LOCAL_EXECUTION_HOST_ID,
            label: 'Local',
            repoCommands: [],
            globalCommands: []
          }
        ]}
        quickCommandHostLoadFailed={false}
        quickCommandHostOwnershipPending={false}
        quickCommandRepoLabel="orca"
        onQuickCommand={noop}
        onAddQuickCommand={noop}
        onToggleExpand={noop}
        onSetTitle={noop}
        onClearPaneTitle={noop}
        canClearPaneTitle={false}
        onCopyTerminalId={noop}
        onCopyPaneId={noop}
        canCopyAgentSessionId={false}
        onCopyAgentSessionId={noop}
        linkTarget={{
          url: 'https://github.com/stablyai/orca/pull/1234',
          worktreeId: 'fixture-worktree',
          sourceOwner: { kind: 'local' },
          canOpenOwnedBrowser: false
        }}
      />
    </div>
  )
}

export const linkMenu = defineFixture({
  width: 620,
  store: {
    installedBrowsers: [
      { id: 'com.google.Chrome', name: 'Google Chrome' },
      { id: 'com.microsoft.edgemac', name: 'Microsoft Edge' },
      { id: 'com.apple.Safari', name: 'Safari' }
    ]
  },
  render: () => <TerminalContextMenuOnLink />,
  // Expand "Open in" so the installed browsers are captured.
  interact: () => {
    const openIn = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    ).find((trigger) => trigger.textContent === 'Open in')
    openIn?.focus()
    openIn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  }
})
