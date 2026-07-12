// Why: a single, host-aware parser for the review target named in a prompt (a
// PR, MR, issue, or ticket), shared by the sidebar workspace name and the tab
// title so both surface the same identifier. URLs are validated by *path
// structure* (owner/repo/pull/N, GitLab's `/-/` marker) rather than hostname,
// which keeps GitHub Enterprise and self-hosted GitLab working while rejecting
// stray URLs that merely contain `/pull/<n>` (CDN assets, docs pages).

export type WorkIdentifier = {
  /** Human label, identifier-first, e.g. `PR 1033`, `MR 42`, `ENG-456`. */
  label: string
  /** Lowercased identifier tokens, so consumers can drop them from a slug or
   *  description rather than echoing `Pr`, a bare number, or the ticket twice. */
  tokens: string[]
}

// Prompts can be paste-sized, and a review target is named up front — so bound
// the scan to a prefix rather than running regexes over the whole prompt.
const IDENTIFIER_SCAN_LIMIT = 4096

// Uppercase prefixes that look like Jira/Linear keys but are standards, ciphers,
// or encodings — kept off the ticket path so `SHA-256` / `UTF-8` / `ISO-8601`
// don't become workspace names. Single-letter prefixes (`P-256`) can't match the
// two-letter-minimum pattern, so they need no entry here.
const NON_TICKET_PREFIXES = new Set([
  'UTF',
  'SHA',
  'MD',
  'ISO',
  'RFC',
  'AES',
  'RSA',
  'EC',
  'ES',
  'RS',
  'HS',
  'PS',
  'GPT',
  'MPEG',
  'UTC',
  'GMT',
  'IPV',
  'IEEE',
  'ANSI',
  'ASCII',
  'TLS',
  'SSL',
  'HTTP',
  'HTTPS'
])

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"']+/gi
// GitLab's project-internal `/-/` marker is unambiguous; a GitLab issue path
// also would not match the GitHub pattern, so ordering GitLab first is safe.
const GITLAB_ITEM_PATH = /\/-\/(issues|work_items|merge_requests)\/(\d+)(?:[/?#]|$)/i
const GITHUB_ITEM_PATH = /^\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)(?:[/?#]|$)/i
const BITBUCKET_ITEM_PATH = /^\/[^/]+\/[^/]+\/pull-requests\/(\d+)(?:[/?#]|$)/i

function taggedIdentifier(type: 'PR' | 'MR' | 'Issue', num: string): WorkIdentifier {
  return { label: `${type} ${num}`, tokens: [type.toLowerCase(), num] }
}

function urlToIdentifier(raw: string): WorkIdentifier | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  const path = url.pathname
  const gitlab = GITLAB_ITEM_PATH.exec(path)
  if (gitlab) {
    return gitlab[1].toLowerCase() === 'merge_requests'
      ? taggedIdentifier('MR', gitlab[2])
      : taggedIdentifier('Issue', gitlab[2])
  }
  const github = GITHUB_ITEM_PATH.exec(path)
  if (github) {
    return github[1].toLowerCase() === 'pull'
      ? taggedIdentifier('PR', github[2])
      : taggedIdentifier('Issue', github[2])
  }
  const bitbucket = BITBUCKET_ITEM_PATH.exec(path)
  if (bitbucket) {
    return taggedIdentifier('PR', bitbucket[1])
  }
  return null
}

function findUrlIdentifier(text: string): WorkIdentifier | null {
  const urls = text.match(URL_IN_TEXT)
  if (!urls) {
    return null
  }
  for (const raw of urls) {
    // Trim trailing sentence punctuation and markdown emphasis (`_`/`*`/`~`): a
    // URL wrapped like `_…/pull/5_` otherwise keeps the `_`, breaking the path
    // anchor so the identifier is lost. Interior `_` (`merge_requests`) is kept.
    const identifier = urlToIdentifier(raw.replace(/[.,;:!?*_~]+$/, ''))
    if (identifier) {
      return identifier
    }
  }
  return null
}

/**
 * Pull the review-target identifier out of raw prompt text. Precedence runs from
 * most reliable (provider URLs) to least (a bare `#123`), so a real URL wins over
 * an incidental ticket-shaped token. Returns null when the prompt names none.
 */
export function extractWorkIdentifier(text: string): WorkIdentifier | null {
  const scanned = text.slice(0, IDENTIFIER_SCAN_LIMIT)

  const urlIdentifier = findUrlIdentifier(scanned)
  if (urlIdentifier) {
    return urlIdentifier
  }

  // Textual references ("pull request #12", "PR 12", "issue 88").
  let match = scanned.match(/\bmerge\s+request\s*[#!]?\s*(\d+)/i)
  if (match) {
    return taggedIdentifier('MR', match[1])
  }
  match = scanned.match(/\bpull\s+request\s*#?\s*(\d+)/i) ?? scanned.match(/\bpr\s*#?\s*(\d+)/i)
  if (match) {
    return taggedIdentifier('PR', match[1])
  }
  match = scanned.match(/\bissue\s*#?\s*(\d+)/i)
  if (match) {
    return taggedIdentifier('Issue', match[1])
  }

  // Namespaced ticket id (Jira/Linear), used bare. Uppercase-only so lowercase
  // tokens like `gpt-4` don't match; skip standards/cipher prefixes, and keep
  // scanning so a real key after one (e.g. `SHA-256 … ENG-456`) still resolves.
  for (const ticket of scanned.matchAll(/\b([A-Z]{2,10})-(\d{1,7})\b/g)) {
    if (!NON_TICKET_PREFIXES.has(ticket[1])) {
      return { label: `${ticket[1]}-${ticket[2]}`, tokens: [ticket[1].toLowerCase(), ticket[2]] }
    }
  }

  // Bare `#123` as a last resort — identifier-first but provider-agnostic.
  match = scanned.match(/(?:^|\s)#(\d+)\b/)
  if (match) {
    return { label: `#${match[1]}`, tokens: [match[1]] }
  }

  return null
}

/**
 * Compose an identifier-first label — `PR 1033 - Review`, or just `PR 1033` when
 * there is no trailing detail. The single source of the format shared by the
 * sidebar name, tab title, and auto-rename name so they cannot drift apart.
 */
export function formatIdentifierFirst(label: string, detail: string): string {
  return detail ? `${label} - ${detail}` : label
}

/**
 * Remove the identifier's own tokens from a description so a caller can prepend
 * the label without echoing it — `PR 1094 - Review this PR` becomes
 * `PR 1094 - Review this`.
 */
export function stripWorkIdentifierEcho(text: string, identifier: WorkIdentifier): string {
  let stripped = text
  for (const token of identifier.tokens) {
    stripped = stripped.replace(new RegExp(`\\b${token}\\b`, 'gi'), ' ')
  }
  return stripped.replace(/\s+/g, ' ').trim()
}
