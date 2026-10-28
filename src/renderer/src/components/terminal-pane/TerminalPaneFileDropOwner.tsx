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
