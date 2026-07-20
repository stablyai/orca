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
 * Ordered starter pack. Order is the status-bar list order after seed.
 * Keep this list intentional — do not auto-append the full 3k+ gallery.
 */
export const PETDEX_STARTER_SLUGS: readonly string[] = [
  'blue-boba-axolotl',
  'nous-girl',
  'spike-gremlin',
  'claude-spectacles-3',
  'glitchcat',
  'belayer-cat',
  'mofu-2',
  'avocadouaena',
  'doc-volt',
  'astro-ops',
  'ostrom',
  'humboldt',
  'panam',
  'jill-stingray',
  'maisenpai',
  'marcille-dungeon-meshi',
  'artoria-saber',
  'heimerdinger',
  'strike-freedom',
  'koharu',
  'pearl-houzuki-2',
  'maruko',
  'ray-2',
  'dylan-harper',
  'paperclip',
  'dalek',
  'batmeme',
  'homelander',
  'mecha-xiaobai',
  'lulu-capybara-2',
  'shuangsheng-linger',
  'erii-2'
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
