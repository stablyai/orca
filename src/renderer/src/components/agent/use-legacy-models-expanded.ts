import { useState } from 'react'

/** Legacy section expansion: opens once when the current model is legacy, then follows the user. */
export function useLegacyModelsExpanded(currentIsLegacy: boolean): [boolean, () => void] {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  // Why during render: a late catalog can mark the current model legacy after the list opened.
  if (expanded === null && currentIsLegacy) {
    setExpanded(true)
  }
  return [expanded ?? currentIsLegacy, () => setExpanded((shown) => !(shown ?? currentIsLegacy))]
}
