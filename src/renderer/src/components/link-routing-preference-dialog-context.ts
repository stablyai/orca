import { createContext, useContext } from 'react'

export type LinkRoutingPreferenceDialogOptions = {
  url?: string
  preview?: boolean
  openLinksInAppDefault?: boolean
}

export type LinkRoutingPreferenceDialogContextValue = (
  options?: LinkRoutingPreferenceDialogOptions
) => Promise<boolean>

// Keep the context component-free so Fast Refresh preserves its identity.
export const LinkRoutingPreferenceDialogContext =
  createContext<LinkRoutingPreferenceDialogContextValue | null>(null)

export function useLinkRoutingPreferenceDialog(): LinkRoutingPreferenceDialogContextValue {
  const requestPreference = useContext(LinkRoutingPreferenceDialogContext)
  if (!requestPreference) {
    throw new Error(
      'useLinkRoutingPreferenceDialog must be used inside LinkRoutingPreferenceDialogProvider'
    )
  }
  return requestPreference
}
