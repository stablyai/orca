import { createContext, useContext } from 'react'
import type { LucideIcon } from 'lucide-react'

// Keep the context component-free so Fast Refresh preserves its identity.

export type ConfirmationDialogField = {
  id: string
  label: string
  type?: 'text' | 'password'
  autoComplete?: string
}

export type ConfirmationDialogOptions = {
  title: string
  description?: string
  descriptionClassName?: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'default' | 'destructive'
  icon?: LucideIcon
  cancelVariant?: 'outline' | 'ghost'
  initialFocus?: 'confirm'
  /** The short close-prompt look: small title, text and buttons. */
  compact?: boolean
  /** Opened by a click or Enter: an outside press, a repeated Enter or a double-click's second
   *  click can't settle it on either button; Esc and a fresh press still do. */
  ignoresOpeningGesture?: boolean
  /** Renders a "Don't ask again" checkbox. `onConfirmed` runs only when the user confirms with it checked. */
  dontAskAgain?: { label?: string; onConfirmed: () => void }
  /** Runs when the cancel button settles the prompt, unlike Esc, an outside press or an abort. */
  onCancelClicked?: () => void
  /** Renders text inputs; Enter in one confirms. `onConfirmed` gets their values, only on confirm. */
  fields?: {
    inputs: ConfirmationDialogField[]
    onConfirmed: (values: Record<string, string>) => void
  }
  /** Aborting dismisses the prompt, queued or showing, and resolves it as cancelled. */
  signal?: AbortSignal
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
