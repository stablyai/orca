import { createContext, useContext } from 'react'

export type UnifiedDialogSize = 'confirm' | 'form' | 'list' | 'review'

export type DialogLayout = {
  /** The dialog uses one of the unified sizes, so its parts use the unified type scale. */
  unified: boolean
  /** Work is running; the dialog cannot be dismissed. */
  busy: boolean
}

export const DialogLayoutContext = createContext<DialogLayout>({ unified: false, busy: false })

export function useDialogLayout(): DialogLayout {
  return useContext(DialogLayoutContext)
}

export function isUnifiedDialogSize(size: string | undefined): size is UnifiedDialogSize {
  return size === 'confirm' || size === 'form' || size === 'list' || size === 'review'
}
