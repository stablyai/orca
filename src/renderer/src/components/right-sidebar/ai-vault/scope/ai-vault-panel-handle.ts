import { useImperativeHandle, type ReactNode, type Ref, type RefObject } from 'react'
import type {
  AiVaultAgent,
  AiVaultScope
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultPanelWorkspace } from './ai-vault-panel-workspace'
import type { AiVaultResumeHere } from '../session-actions/ai-vault-session-resume-here'

export type AiVaultPanelHandle = {
  /** Focuses the search box, first switching scope when one is given. */
  focusSearch: (scope?: AiVaultScope) => void
  /** Clears a non-empty search; false when there was nothing to clear. */
  clearSearch: () => boolean
}

export type AiVaultPanelProps = {
  ref?: Ref<AiVaultPanelHandle>
  /** Absent means the active workspace. */
  workspace?: AiVaultPanelWorkspace
  /** Read once, at mount. */
  initialQuery?: string
  /** Read once, at mount; set, the panel filters agents on its own and never saves the filter. */
  initialAgents?: readonly AiVaultAgent[]
  conversationNavigation?: boolean
  headerAction?: ReactNode
  /** Success may leave the tab unchanged; providing this callback also enables arrow/Enter row keys. */
  onSessionOpened?: () => void
  /** Set in `/resume`: picking a row resumes it in that chat, and rows offer no other action. */
  resumeHere?: AiVaultResumeHere
}

export function useAiVaultPanelHandle(
  ref: Ref<AiVaultPanelHandle> | undefined,
  panel: {
    query: string
    setQuery: (query: string) => void
    changeScope: (scope: AiVaultScope) => void
    searchInputRef: RefObject<HTMLInputElement | null>
  }
): void {
  const { query, setQuery, changeScope, searchInputRef } = panel
  useImperativeHandle(
    ref,
    () => ({
      focusSearch: (nextScope) => {
        if (nextScope) {
          changeScope(nextScope)
        }
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      },
      clearSearch: () => {
        setQuery('')
        return query !== ''
      }
    }),
    [changeScope, query, searchInputRef, setQuery]
  )
}
