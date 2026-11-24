import { useCallback } from 'react'
import { useAppStore } from '../../../store/index'

export function useTerminalSelectionSearch() {
  const handleSearchSelectedText = useCallback((selectedText: string): void => {
    useAppStore.getState().showRightSidebarSearch({ query: selectedText })
  }, [])
  return { handleSearchSelectedText }
}
