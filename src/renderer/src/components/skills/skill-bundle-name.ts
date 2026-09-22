import type { DiscoveredSkill } from '../../../../shared/skills'

/** Mirrors `PLUGIN_NAME_PATTERN` in `skill-bundle-manifest.ts`: lowercase
 *  alphanumerics plus `.`/`-`, no `--`/`..`, no leading or trailing separator. */
const MAX_BUNDLE_NAME = 64
const FALLBACK_BUNDLE_NAME = 'shared-skills'

function slugify(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/[-.]{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/**
 * Every multi-skill bundle used to publish as `shared-skills`, so a list of
 * links showed the same name N times. Naming a bundle after its first skill and
 * how many others ride along makes each link identifiable without asking the
 * publisher for a name.
 */
export function derivedBundleName(skills: readonly DiscoveredSkill[]): string {
  const first = slugify(skills[0]?.name ?? '')
  if (!first) {
    return FALLBACK_BUNDLE_NAME
  }
  const others = skills.length - 1
  if (others <= 0) {
    return first.slice(0, MAX_BUNDLE_NAME).replace(/[-.]+$/g, '') || FALLBACK_BUNDLE_NAME
  }
  const suffix = `-and-${others}-more`
  const head = first.slice(0, MAX_BUNDLE_NAME - suffix.length).replace(/[-.]+$/g, '')
  return head ? `${head}${suffix}` : FALLBACK_BUNDLE_NAME
}
