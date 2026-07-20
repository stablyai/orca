/**
 * Curated Petdex starter pack for Orca.
 *
 * Hermes does not ship pet sprites in-repo — it fetches the public Petdex
 * gallery (`https://petdex.dev/api/manifest` → assets.petdex.dev). This
 * catalog is the mesh-quality shortlist we install into Orca's customPets
 * so the status-bar picker is not stuck on the three bundled webps.
 *
 * Selection criteria (operator bar):
 *  - creature / character preferred (not furniture "object" filler)
 *  - real Petdex slugs known to resolve at seed time
 *  - mix of mesh-adjacent (Nous / Claude / gremlin) + delightful creatures
 *  - labels ASCII-friendly where possible; non-ASCII display names kept as
 *    published by Petdex so attribution stays honest
 */

export const PETDEX_MANIFEST_URL = 'https://petdex.dev/api/manifest'

/** Hosts we will download from (anti-SSRF; mirrors hermes agent/pet/store). */
export const PETDEX_ALLOWED_HOSTS = new Set(['petdex.dev', 'assets.petdex.dev'])

export type PetdexManifestEntry = {
  slug: string
  displayName: string
  kind?: string
  submittedBy?: string
  spritesheetUrl: string
  petJsonUrl?: string
  zipUrl?: string
}

export type PetdexManifest = {
  generatedAt?: string
  total?: number
  pets: PetdexManifestEntry[]
}

/**
 * Ordered starter pack = operator-curated keepers on node-b (2026-07-20).
 * Do NOT re-add slugs the operator deleted from the Orca GUI — this list is
 * the source of truth for re-seed and node-e transfer. Full Petdex gallery
 * remains available via one-off import / future gallery UI, not this pack.
 */
export const PETDEX_STARTER_SLUGS: readonly string[] = [
  'blue-boba-axolotl',
  'nous-girl',
  'glitchcat',
  'belayer-cat',
  'doc-volt',
  'panam',
  'jill-stingray',
  'marcille-dungeon-meshi',
  'heimerdinger',
  'strike-freedom',
  'paperclip',
  'batmeme'
] as const

export function isPetdexAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return PETDEX_ALLOWED_HOSTS.has(host) || host.endsWith('.petdex.dev')
  } catch {
    return false
  }
}

/** Resolve starter slugs against a live manifest; drop missing entries. */
export function selectStarterEntries(
  manifest: PetdexManifest,
  slugs: readonly string[] = PETDEX_STARTER_SLUGS
): PetdexManifestEntry[] {
  const bySlug = new Map(manifest.pets.map((p) => [p.slug, p]))
  const out: PetdexManifestEntry[] = []
  for (const slug of slugs) {
    const entry = bySlug.get(slug)
    if (!entry) continue
    if (!isPetdexAllowedUrl(entry.spritesheetUrl)) continue
    out.push(entry)
  }
  return out
}
