import type { DevRule } from './types'

// Distinct markers so the block never collides with other managed regions in
// the same file (e.g. an IJFW-MEMORY block). Matching is anchored on these
// exact tokens, so unrelated managed blocks are left untouched.
export const DEV_RULES_BLOCK_START = '<!-- ORCA-DEV-RULES:START (managed by Orca — do not edit) -->'
export const DEV_RULES_BLOCK_END = '<!-- ORCA-DEV-RULES:END -->'
const DEV_RULES_BLOCK_INFO =
  '<!-- Auto-generated from Orca Settings → Dev Rules. Manual edits inside this block are overwritten. -->'

const START_TOKEN = '<!-- ORCA-DEV-RULES:START'

// Fresh RegExp per call: a shared /g regex carries lastIndex state across calls.
function blockRegex(): RegExp {
  return /(?:\r?\n)*<!-- ORCA-DEV-RULES:START[\s\S]*?<!-- ORCA-DEV-RULES:END -->[ \t]*/g
}

export function hasManagedDevRulesBlock(content: string): boolean {
  return content.includes(START_TOKEN)
}

// Why: a rule's name/content is user text. If it contained the literal marker
// token, the (non-greedy) block regex would match that inner token on the next
// sync and corrupt the managed block. Insert a zero-width space into the token
// so it can never be mistaken for our real marker; the text still reads the same.
function neutralizeMarkerTokens(text: string): string {
  return text.replace(/ORCA-DEV-RULES/g, 'ORCA-DEV-​RULES')
}

function renderRuleSection(rule: DevRule): string {
  const content = neutralizeMarkerTokens(rule.content.replace(/\r\n/g, '\n').trim())
  if (!content) {
    return ''
  }
  // Strip leading "#" so a name can't escape the heading level it's rendered at.
  const name = neutralizeMarkerTokens(
    rule.name
      .replace(/\r\n/g, '\n')
      .trim()
      .replace(/^#+\s*/, '')
  )
  if (!name) {
    return content
  }
  return `## ${name}\n\n${content}`
}

/** Render enabled rules into one managed block. Returns '' when nothing renders. */
export function renderDevRulesBlock(rules: DevRule[]): string {
  const sections = rules.map(renderRuleSection).filter((section) => section.length > 0)
  if (sections.length === 0) {
    return ''
  }
  return [
    DEV_RULES_BLOCK_START,
    DEV_RULES_BLOCK_INFO,
    '',
    sections.join('\n\n'),
    DEV_RULES_BLOCK_END
  ].join('\n')
}

// Strip the managed block (if any) and normalize surrounding whitespace. Returns
// the remaining content with no leading/trailing blank lines and no trailing
// newline; '' when nothing else remains.
function stripBlock(existing: string): string {
  return existing
    .replace(blockRegex(), '\n')
    .replace(/^\s+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
}

/** Remove the managed block, preserving everything else. '' if the file held
 *  only the block. */
export function removeManagedBlock(existing: string): string {
  const base = stripBlock(existing)
  return base.length === 0 ? '' : `${base}\n`
}

/** Insert or replace the managed block. Existing block is stripped wherever it
 *  was and the new block is appended at EOF, so repeated calls converge
 *  (idempotent). A null/absent file yields just the block. */
export function upsertManagedBlock(existing: string | null, block: string): string {
  const base = existing ? stripBlock(existing) : ''
  if (base.length === 0) {
    return `${block}\n`
  }
  return `${base}\n\n${block}\n`
}
