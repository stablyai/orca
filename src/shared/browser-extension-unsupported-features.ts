/** Features an extension can ask for that Orca's browser does not provide yet. */
export type UnsupportedBrowserExtensionFeature = 'contentBlocking' | 'identity'

function featureFor(permission: string): UnsupportedBrowserExtensionFeature | null {
  switch (permission) {
    // Why: Electron accepts declarativeNetRequest rules but never applies them.
    case 'declarativeNetRequest':
    case 'declarativeNetRequestWithHostAccess':
      return 'contentBlocking'
    case 'identity':
    case 'identity.email':
      return 'identity'
    default:
      return null
  }
}

export function unsupportedBrowserExtensionFeatures(
  permissions: string[]
): UnsupportedBrowserExtensionFeature[] {
  const features = permissions.map(featureFor).filter((feature) => feature !== null)
  return [...new Set(features)]
}
