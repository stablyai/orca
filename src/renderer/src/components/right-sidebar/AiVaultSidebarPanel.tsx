import { useRef } from 'react'
import AiVaultPanel from './AiVaultPanel'
import type { AiVaultPanelHandle } from './ai-vault-panel-handle'
import { focusActiveTabSurface } from '@/lib/focus-active-tab-surface'
import { useAiVaultSearchFocusRequest } from './use-ai-vault-search-focus-request'

/** Only the sidebar takes Settings' focus request, so other hosts never widen to All. */
export default function AiVaultSidebarPanel(): React.JSX.Element {
  const panelRef = useRef<AiVaultPanelHandle>(null)
  useAiVaultSearchFocusRequest((keepScope) =>
    panelRef.current?.focusSearch(keepScope ? undefined : 'all')
  )
  return <AiVaultPanel ref={panelRef} onSearchEscape={focusActiveTabSurface} />
}
