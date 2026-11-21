import { createContext, useContext } from 'react'
import type { FileExplorerHostMode } from './use-file-explorer-host-mode'

// Why: kept apart from the components so React Fast Refresh can hot-swap them in dev.
export const HostModeContext = createContext<FileExplorerHostMode | null>(null)

export function useFileExplorerHostModeContext(): FileExplorerHostMode {
  const hostMode = useContext(HostModeContext)
  if (!hostMode) {
    throw new Error('FileExplorerHostModeProvider is missing')
  }
  return hostMode
}
