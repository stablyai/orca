/**
 * Shared recipes for the composer's type-ahead pickers, so Project and Run on
 * can't drift apart.
 */

/** Input-shaped shell without being an `<Input>` — the field wraps a bare input. */
export const COMBOBOX_FIELD_SHELL =
  'flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30'

/**
 * Opaque and unfaded, unlike the shared popover recipe. These land directly on
 * the composer dialog, so a translucent fade shows the form underneath
 * mid-animation and the open reads as a double flash.
 */
export const COMBOBOX_POPOVER_SURFACE =
  'bg-[var(--popover)] data-[state=closed]:fade-out-100 data-[state=open]:fade-in-100 dark:bg-[var(--popover)]'
