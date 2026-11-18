declare global {
  // Global so upstream suites that reset modules keep asserting Orca's own copy.
  var zotzBrandCopyDisabledForTests: boolean | undefined
}

export function _setZotzBrandCopyDisabledForTests(disabled: boolean): void {
  globalThis.zotzBrandCopyDisabledForTests = disabled
}

// Zotz copy names Orca on purpose (its base version, the official Orca app); leave it alone.
const ZOTZ_COPY_NAMESPACE = 'zotz'
const ORCA_WORD = /\bOrca\b/g
// The official Orca Mobile app keeps its name: Zotz pairs with it unchanged.
const KEEPS_ORCA_AFTER = /^\s+[Mm]obile\b|^ app on this (?:device|phone)\b/
const KEEPS_ORCA_BEFORE = /m[óo]vil(?:es)? (?:de|para) $/

/** Rebrands visible copy without touching interpolated values, which are applied later. */
export function applyZotzBrandToCopy(text: string): string {
  if (globalThis.zotzBrandCopyDisabledForTests || !text.includes('Orca')) {
    return text
  }
  return text.replace(ORCA_WORD, (match, offset: number) => {
    const before = text.slice(Math.max(0, offset - 24), offset)
    const after = text.slice(offset + match.length, offset + match.length + 24)
    const keeps =
      KEEPS_ORCA_AFTER.test(after) ||
      KEEPS_ORCA_BEFORE.test(before) ||
      (before.endsWith('app de ') && /^ en este (?:dispositivo|teléfono)/.test(after))
    return keeps ? match : 'Zotz'
  })
}

export function isZotzCopyKey(key: string): boolean {
  return key === ZOTZ_COPY_NAMESPACE || key.startsWith(`${ZOTZ_COPY_NAMESPACE}.`)
}

/** Copy of a nested i18n catalog with every string rebranded except the `zotz` namespace. */
export function applyZotzBrandToCatalog(catalog: Record<string, unknown>): Record<string, unknown> {
  if (globalThis.zotzBrandCopyDisabledForTests) {
    return catalog
  }
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return applyZotzBrandToCopy(value)
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    }
    return value
  }
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]) => [
      key,
      key === ZOTZ_COPY_NAMESPACE ? value : visit(value)
    ])
  )
}
