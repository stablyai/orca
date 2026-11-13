import * as z from 'zod'
import {
  canonicalizeWindowsShellOverride,
  isSupportedWindowsShellOverride,
  listSupportedWindowsShellOverrides
} from '../../windows-terminal-shell'

// Refuse at the authoritative host boundary instead of returning an opaque relay spawn failure.
export const WindowsShellOverrideParam = z
  .string()
  .refine(isSupportedWindowsShellOverride, {
    message: `shell must be one of: ${listSupportedWindowsShellOverrides().join(', ')}`
  })
  // Canonicalize host-side to the .exe spellings exact-matched by spawn, even if the client did not.
  .transform((shell) => canonicalizeWindowsShellOverride(shell) ?? shell)
