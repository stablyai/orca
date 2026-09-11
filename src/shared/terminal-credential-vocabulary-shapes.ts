// Expands the detector's OWN vocabulary into concrete sample phrases, so a suite can cross every
// credential term it knows against the shapes that term appears in when it is NOT a prompt.
//
// Why derive from the source strings rather than list terms by hand: three separate false-positive
// classes shipped past a hand-written corpus, each one a term appearing in a position nobody had
// thought to write down. A hand-maintained list has exactly the same blind spot as the corpus it
// would be replacing. This one grows automatically the moment somebody adds a noun or a flow
// phrase to the detector.
import {
  AUTH_ACTION_FLOW_SOURCE,
  AUTH_TOPIC_FLOW_SOURCE,
  AUTH_VERB_SOURCE,
  CREDENTIAL_NOUN_SOURCE
} from './terminal-credential-prompt-detection'

/** Splits a regex alternation on its TOP-level `|` only, ignoring `|` inside groups or classes. */
function topLevelAlternatives(source: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inClass = false
  let current = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') {
      current += char + (source[index + 1] ?? '')
      index += 1
      continue
    }
    if (inClass) {
      inClass = char !== ']'
      current += char
      continue
    }
    if (char === '[') {
      inClass = true
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
    } else if (char === '|' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.filter((part) => part.length > 0)
}

/** Collapses one alternative into the plain phrase a terminal would actually show. */
function toSamplePhrase(alternative: string): string {
  return alternative
    .replace(/\(\?:([^()|]*)(?:\|[^()]*)?\)\??/g, '$1') // first branch of a non-capturing group
    .replace(/\[[^\]]*\]\??/g, ' ') // a character class stands in for its separator
    .replace(/\\d/g, '6')
    .replace(/\\b/g, '')
    .replace(/[a-z0-9]\?/gi, '') // an optional letter (`keys?`) is absent in the singular form
    .replace(/\s+/g, ' ')
    .trim()
}

function expand(source: string): string[] {
  const seen = new Set<string>()
  for (const alternative of topLevelAlternatives(source)) {
    const phrase = toSamplePhrase(alternative)
    if (phrase.length > 0 && /^[a-z0-9 ]+$/i.test(phrase)) {
      seen.add(phrase)
    }
  }
  return [...seen]
}

/** Every credential noun the detector knows, as a plain phrase ("api key", "one time code"). */
export const CREDENTIAL_NOUN_SAMPLES: readonly string[] = expand(CREDENTIAL_NOUN_SOURCE)

/** Every auth flow phrase the detector knows, as a plain phrase. */
export const AUTH_FLOW_SAMPLES: readonly string[] = [
  ...expand(AUTH_ACTION_FLOW_SOURCE),
  ...expand(AUTH_TOPIC_FLOW_SOURCE)
]

/**
 * Shapes a credential term appears in when it is OUTPUT rather than a prompt. Each takes the term
 * and returns the row as the grid would show it.
 *
 * The ternary shape is the one that shipped: `AUTH_QUESTION_ROW_RE` rests on "prose never starts
 * with a bare `?`", which is true of prose and false of formatted code.
 */
export const NON_PROMPT_ROW_SHAPES: readonly ((term: string) => string)[] = [
  (term) => `      ? '${term} is required for this account'`,
  (term) => `        ? buildMessage('${term}')`,
  (term) => `    // The caller must provide the current ${term}`,
  (term) => `   * Callers are expected to paste their ${term}`,
  (term) => `    const label = '${term}'`,
  (term) => `      label: '${term}',`,
  (term) => `+  console.log('${term}')`,
  (term) => `  └ src/auth.ts:42:  const value = readSetting('${term}')`,
  (term) => `    expect(screen.getByText('${term}')).toBeVisible()`,
  (term) => `  ✓ auth > rejects a stale ${term} (4 ms)`,
  (term) => `| \`${term}\` | the value the provider issued |`,
  (term) => `> Refactor the ${term} module`
]

/** Composer chrome an idle agent leaves on the bottom rows. */
export const AGENT_COMPOSER_TAILS: readonly (readonly [string, string[]])[] = [
  ['codex', ['› Ask Codex to do anything']],
  ['claude', ['✳ Claude Code', '> ']],
  ['opencode', ['❯ ']],
  ['gemini', ['◇ ']]
]

/** Every auth verb the detector knows, as a plain phrase ("sign in", "authorization"). */
export const AUTH_VERB_SAMPLES: readonly string[] = expand(AUTH_VERB_SOURCE)

/**
 * A term rendered as an identifier, which is what `\b` mistakes for the word itself: `user.login`
 * is a property access, not somebody logging in.
 */
export function asPropertyAccess(term: string): string {
  return `    const owner = candidate.${term.replace(/ /g, '')}`
}

/**
 * Bottom rows that DO lead with an action phrase but carry no auth verb and no credential noun of
 * their own, so the screen turns entirely on whether something ELSE in the window corroborates
 * them. Pairs with `asPropertyAccess` to prove an identifier cannot. A row containing its own verb
 * (`Waiting for you to sign in`) corroborates itself and would make this probe vacuous.
 */
export const CORROBORATION_SEEKING_BOTTOM_ROWS: readonly string[] = [
  '    Enter the code below to finish linking the account',
  '  Press enter to open the browser'
]
