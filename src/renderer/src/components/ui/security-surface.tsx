import type React from 'react'
import * as Slot from 'radix-ui/slot'

/** Host-owned tokens a plugin theme cannot restyle; see `.plugin-security-chrome` in main.css. */
export const SECURITY_SURFACE_CLASS = 'plugin-security-chrome'

/** Puts its one child element on the host-owned token surface. For trust decisions outside a
 *  dialog (an agent approval, a certificate override); dialogs use `surface="security"`. */
export function SecuritySurface({ children }: { children: React.ReactElement }): React.JSX.Element {
  return (
    <Slot.Root data-slot="security-surface" className={SECURITY_SURFACE_CLASS}>
      {children}
    </Slot.Root>
  )
}
