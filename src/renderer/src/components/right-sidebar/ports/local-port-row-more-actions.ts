import type React from 'react'

/**
 * The row menu is a context menu; this opens it under the More actions button so keyboard and
 * trackpad users reach Share… (Orca Cloud) and the rest.
 */
export function openPortRowMenuBelow(
  menuTrigger: HTMLElement | null,
  event: React.MouseEvent<HTMLButtonElement>
): void {
  const rect = event.currentTarget.getBoundingClientRect()
  menuTrigger?.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left,
      clientY: rect.bottom
    })
  )
}
