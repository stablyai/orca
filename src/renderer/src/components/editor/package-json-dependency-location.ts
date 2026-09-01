import { getLocation } from 'jsonc-parser'

export const PACKAGE_JSON_DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'catalog'
] as const

export type PackageJsonDependencySection = (typeof PACKAGE_JSON_DEPENDENCY_SECTIONS)[number]

export type PackageJsonDependencyLocation = {
  packageName: string
  section: PackageJsonDependencySection
  startOffset: number
  endOffset: number
}

/**
 * Resolves the dependency key (never the version value) at `offset`, gated to
 * the five sections whose entries this feature hovers. `location.matches`
 * rejects `overrides`/`resolutions` and a nested object that coincidentally
 * shares a section name, since both fail the exact top-level path shape.
 */
export function locatePackageJsonDependencyAtOffset(
  text: string,
  offset: number
): PackageJsonDependencyLocation | null {
  const location = getLocation(text, offset)
  const node = location.previousNode
  if (
    !location.isAtPropertyKey ||
    !node ||
    node.type !== 'property' ||
    typeof node.value !== 'string'
  ) {
    return null
  }
  // Why: `previousNode` can still be set while the offset sits in whitespace
  // between the key and the colon — require the offset to land inside the key.
  if (offset < node.offset || offset > node.offset + node.length) {
    return null
  }
  const section = PACKAGE_JSON_DEPENDENCY_SECTIONS.find((candidate) =>
    location.matches([candidate, '*'])
  )
  if (!section) {
    return null
  }
  return {
    packageName: node.value,
    section,
    startOffset: node.offset,
    endOffset: node.offset + node.length
  }
}
