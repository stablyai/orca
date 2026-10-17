import { useRef } from 'react'
import AiVaultPanel from './AiVaultPanel'
import type { AiVaultPanelHandle } from './ai-vault-panel-handle'
import { useAiVaultSearchFocusRequest } from './use-ai-vault-search-focus-request'

/** Only the sidebar takes Settings' focus request, so other hosts never widen to All. */
export default function AiVaultSidebarPanel(): React.JSX.Element {
  const panelRef = useRef<AiVaultPanelHandle>(null)
  // Settings asks for "everything, ready to type".
  useAiVaultSearchFocusRequest(() => panelRef.current?.focusSearch('all'))
  return <AiVaultPanel ref={panelRef} />
}
