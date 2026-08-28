import { createContext, useContext } from 'react'

// Keep the context component-free so Fast Refresh preserves its identity.

export type ConfirmationDialogOptions = {
  title: string
  description?: string
  descriptionClassName?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
  /** Renders a "Don't ask again" checkbox. `onConfirmed` runs only when the user confirms with it checked. */
  dontAskAgain?: { label?: string; onConfirmed: () => void }
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
