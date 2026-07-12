import { humanizeBranchSlug } from './branch-name-from-work'
import { extractWorkIdentifier, formatIdentifierFirst } from './work-item-reference'

// Why: the git branch must stay lowercase kebab-case, but the sidebar display
// name is free-form. When the first prompt references a review target, that
// identifier is the highest-signal, most searchable token — so we lead with it
// (`PR 1033 - Review`) instead of a paraphrased slug like "Review community pr
// 1033". The identifier comes from the raw prompt (via work-item-reference),
// where the number still exists, not from the lossy branch slug.

// Type words that are never a useful action verb, skipped even if a slug leads
// with one (e.g. `pr-1094-review` → `Review`, not `Pr`).
const ACTION_STOPWORDS = new Set([
  'pr',
  'mr',
  'pull',
  'merge',
  'request',
  'requests',
  'issue',
  'issues',
  'the',
  'a',
  'an',
  'to',
  'for',
  'of'
])

// The first slug word that is neither a digit nor an identifier/type token,
// capitalized — the task verb ("Review", "Fix"). '' when none remains.
function leadingActionWord(slug: string, identifierTokens: string[]): string {
  const skip = new Set([...identifierTokens, ...ACTION_STOPWORDS])
  for (const word of slug.split('-').filter(Boolean)) {
    if (/^\d+$/.test(word) || skip.has(word)) {
      continue
    }
    return word.charAt(0).toUpperCase() + word.slice(1)
  }
  return ''
}

// A `-N` collision suffix (`fix-auth` → `fix-auth-2`) that resolveUniqueBranchName
// appended, so two worktrees on the same identifier stay distinguishable.
function collisionSuffixFromLeaf(
  baseSlug: string,
  resolvedLeaf: string | undefined
): number | null {
  if (!resolvedLeaf || resolvedLeaf === baseSlug || !resolvedLeaf.startsWith(`${baseSlug}-`)) {
    return null
  }
  const rest = resolvedLeaf.slice(baseSlug.length + 1)
  return /^\d+$/.test(rest) ? Number(rest) : null
}

/**
 * Build the sidebar display name for a freshly auto-renamed workspace. When the
 * prompt names a review target, returns `<identifier> - <action>` (e.g.
 * `PR 1033 - Review`); otherwise falls back to the plain humanized branch slug.
 * `resolvedLeaf` is the final branch leaf (after any collision suffix); omit it
 * for folder workspaces that have no git branch.
 */
export function deriveWorkspaceDisplayName(input: {
  prompt: string
  slug: string
  resolvedLeaf?: string
}): string {
  const identifier = extractWorkIdentifier(input.prompt)
  if (!identifier) {
    return humanizeBranchSlug(input.resolvedLeaf ?? input.slug)
  }
  const action = leadingActionWord(input.slug, identifier.tokens)
  const base = formatIdentifierFirst(identifier.label, action)
  const suffix = collisionSuffixFromLeaf(input.slug, input.resolvedLeaf)
  return suffix ? `${base} (${suffix})` : base
}
