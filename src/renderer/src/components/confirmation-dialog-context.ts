import { createContext, useContext } from 'react'

// Keep the context component-free so Fast Refresh preserves its identity.

export type ConfirmationDialogOptions = {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
}

export type ConfirmationDialogContextValue = (
  options: ConfirmationDialogOptions
) => Promise<boolean>

export const ConfirmationDialogContext = createContext<ConfirmationDialogContextValue | null>(null)

export function useConfirmationDialog(): ConfirmationDialogContextValue {
  const confirm = useContext(ConfirmationDialogContext)
  if (!confirm) {
    throw new Error('useConfirmationDialog must be used inside ConfirmationDialogProvider')
  }
  return confirm
}
