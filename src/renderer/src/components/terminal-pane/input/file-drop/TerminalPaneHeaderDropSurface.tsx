import type { ComponentProps } from 'react'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import {
  useTerminalPaneFileDropOwner,
  type TerminalPaneFileDropOwnerArgs
} from './use-terminal-pane-file-drop-owner'

export function TerminalPaneHeaderDropSurface({
  destination,
  ...props
}: ComponentProps<'div'> & { destination: TerminalPaneFileDropOwnerArgs }): React.JSX.Element {
  const attach = useTerminalPaneFileDropOwner(destination)
  const isInternal = (types: readonly string[]) =>
    types.includes(WORKSPACE_FILE_PATH_MIME) || types.includes(WORKSPACE_FILE_PATHS_MIME)
  return (
    <div
      {...props}
      ref={attach}
      onDragOver={(event) => {
        if (isInternal(event.dataTransfer.types)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(event) => {
        if (!isInternal(event.dataTransfer.types)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const manager = destination.managerRef.current
        if (!manager) {
          return
        }
        void handleInternalTerminalFileDrop({
          ...destination,
          manager,
          paneTransports: destination.paneTransportsRef.current,
          dataTransfer: event.dataTransfer,
          paneLeafId: destination.pane.leafId
        })
      }}
    />
  )
}
