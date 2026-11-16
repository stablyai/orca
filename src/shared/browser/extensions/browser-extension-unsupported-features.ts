/** Features an extension can ask for that Orca's browser does not provide yet. */
export type UnsupportedBrowserExtensionFeature = 'identity'

function featureFor(permission: string): UnsupportedBrowserExtensionFeature | null {
  switch (permission) {
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
