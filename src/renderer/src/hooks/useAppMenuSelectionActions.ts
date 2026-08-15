import { useEffect } from 'react'
import {
  dispatchAppMenuSelectionAction,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'

export function useAppMenuSelectionActions(): void {
  useEffect(() => {
    return window.api.ui.onAppMenuSelectionAction((action: AppMenuSelectionAction) => {
      if (!dispatchAppMenuSelectionAction(action)) {
        window.api.ui.performNativeSelectionAction(action)
      }
    })
  }, [])
}
