import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalPaneController } from '../../controller/use-terminal-pane-controller'
import { useLayoutEffect } from 'react'
import {
  useTerminalPaneFileDropOwner,
  type TerminalPaneFileDropOwnerArgs
} from './use-terminal-pane-file-drop-owner'

/** The pane manager creates the body container outside React. */
export function TerminalPaneFileDropOwner(args: TerminalPaneFileDropOwnerArgs): null {
  const attach = useTerminalPaneFileDropOwner(args)
  useLayoutEffect(() => {
    attach(args.pane.container)
    return () => attach(null)
  }, [attach, args.pane.container])
  return null
}

export function TerminalPaneFileDropOwners({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes, tabId, worktreeId, cwd, managerRef, paneTransportsRef } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <TerminalPaneFileDropOwner
          key={makePaneKey(tabId, pane.leafId)}
          pane={pane}
          tabId={tabId}
          worktreeId={worktreeId}
          cwd={cwd}
          managerRef={managerRef}
          paneTransportsRef={paneTransportsRef}
        />
      ))}
    </>
  )
}
