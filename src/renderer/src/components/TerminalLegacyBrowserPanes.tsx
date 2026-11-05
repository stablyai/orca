import BrowserPane from './browser-pane/BrowserPane'
import type { TerminalController } from './use-terminal-controller'

export function TerminalLegacyBrowserPanes({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const {
    activeBrowserTabId,
    activeTabType,
    activeView,
    browserTabsByWorktree,
    renderedActiveWorktreeId,
    workspaceSurfaces
  } = controller
  return (
    <div
      className={`relative flex-1 min-h-0 overflow-hidden ${
        activeTabType !== 'browser' ? 'hidden' : ''
      }`}
    >
      {workspaceSurfaces.map((workspace) => {
        const browserTabs = browserTabsByWorktree[workspace.id] ?? []
        const isVisibleWorktree =
          activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
        if (browserTabs.length === 0) {
          return null
        }
        return (
          <div
            key={`browser-${workspace.id}`}
            className={isVisibleWorktree ? 'absolute inset-0' : 'absolute inset-0 hidden'}
            aria-hidden={!isVisibleWorktree}
          >
            {browserTabs.map((browserTab) => {
              const isBrowserActive =
                isVisibleWorktree &&
                activeTabType === 'browser' &&
                browserTab.id === activeBrowserTabId
              return (
                <div
                  key={browserTab.id}
                  className={`absolute inset-0${
                    isBrowserActive ? '' : ' pointer-events-none hidden'
                  }`}
                >
                  {isBrowserActive ? (
                    <BrowserPane browserTab={browserTab} isActive={isBrowserActive} />
                  ) : null}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
