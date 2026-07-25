/**
 * Mesh default pets for Orca fork.
 *
 * Source of truth for the shipped pack: operator-curated list after GUI
 * install/delete (2026-07-20). Assets live under
 * `resources/pets/mesh-defaults/<slug>/` (spritesheet.webp + pet.json) and
 * are also installable from Petdex by the same slug.
 *
 * Do not re-add pets the operator removed without an explicit catalog edit.
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
 * Ordered default pack (status-bar order after seed).
 * Labels: preferred UI names when they differ from Petdex displayName.
 */
export const PETDEX_STARTER_SLUGS: readonly string[] = [
  'nous-girl',
  'strike-freedom',
  'gojo',
  'clank',
  'faye',
  'claw-crawler', // UI label: kuro-chan
  'apupepe', // UI label: Pepe
  'rubick',
  'spike',
  'mini-gandalf-the-grey',
  'teknium',
  'nezukocoder'
] as const

/** Preferred status-bar labels (override Petdex displayName when set). */
export const PETDEX_STARTER_LABELS: Readonly<Record<string, string>> = {
  'nous-girl': 'Nous Girl',
  'strike-freedom': 'Strike Freedom Gundam',
  gojo: 'Gojo',
  clank: 'Clank',
  faye: 'Faye',
  'claw-crawler': 'kuro-chan',
  apupepe: 'Pepe',
  rubick: 'Rubick',
  spike: 'Spike',
  'mini-gandalf-the-grey': 'Mini Gandalf the Grey',
  teknium: 'Teknium',
  nezukocoder: 'NezukoCoder'
}

/** Default active pet after seed (operator choice). */
export const PETDEX_DEFAULT_ACTIVE_SLUG = 'mini-gandalf-the-grey'

export function labelForStarterSlug(slug: string, fallback?: string): string {
  return PETDEX_STARTER_LABELS[slug] ?? fallback ?? slug
}

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
    out.push({
      ...entry,
      displayName: labelForStarterSlug(slug, entry.displayName)
    })
  }
  return out
}
