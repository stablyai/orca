import { useEffect, useRef } from 'react'
import AiVaultPanel from './AiVaultPanel'
import type { AiVaultPanelHandle } from '../scope/ai-vault-panel-handle'
import { useAiVaultSearchFocusRequest } from '../search/use-ai-vault-search-focus-request'

/** Only the sidebar takes Settings' focus request, so other hosts never widen to All. */
export default function AiVaultSidebarPanel({
  focusSearch,
  onFocusSearchHandled
}: {
  focusSearch: boolean
  onFocusSearchHandled: () => void
}): React.JSX.Element {
  const panelRef = useRef<AiVaultPanelHandle>(null)
  useAiVaultSearchFocusRequest(() => panelRef.current?.focusSearch('all'))
  useEffect(() => {
    if (focusSearch) {
      panelRef.current?.focusSearch()
      onFocusSearchHandled()
    }
  }, [focusSearch, onFocusSearchHandled])
  return <AiVaultPanel ref={panelRef} />
}
