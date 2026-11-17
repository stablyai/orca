import type * as Monaco from 'monaco-editor'

type MonarchLanguage = Monaco.languages.IMonarchLanguage
type MonarchRule = Monaco.languages.IMonarchLanguageRule
type MonarchAction = Monaco.languages.IMonarchLanguageAction
type ActionPart = string | Monaco.languages.IExpandedMonarchLanguageAction

// Why `keyword.flow`: Monaco's stock themes color it as VS Code themes color `keyword.control`,
// and plugin themes resolve it through their `keyword.control` rule.
const CONTROL_TOKEN = 'keyword.flow'
const MEMBER_STATE = 'orcaControlKeywordMember'
const LIST_ATTRIBUTE = 'orcaControlKeywordWords'

export type ControlKeywordSpec = {
  /** Space-separated words VS Code's grammar for the language scopes `keyword.control`. */
  keywords?: string
  /** Rules, by regex source, whose keyword tokens are all control keywords (`#include`, `@import`). */
  controlRules?: RegExp
  /** The token the language gives `.`, for languages where a keyword right after it names a
   *  member (`promise.catch()`, `re.match()`), which then keeps the language's plain-word token. */
  memberAfterDot?: string
}

const isKeywordToken = (token: string): boolean =>
  token === 'keyword' || token.startsWith('keyword.')

function caseEntries(part: ActionPart): [string, MonarchAction][] {
  return typeof part === 'string' || !part.cases
    ? []
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Monaco types `cases` as `Object`; its values are actions.
      Object.entries(part.cases as Record<string, MonarchAction>)
}

function mapParts(action: MonarchAction, map: (part: ActionPart) => ActionPart): MonarchAction {
  if (!Array.isArray(action)) {
    return map(action)
  }
  const parts = action.map(map)
  return parts.every((part, index) => part === action[index]) ? action : parts
}

/** `part` with its token moved to the control token, or null when it has none to move. */
function controlPart(part: ActionPart, anyToken: boolean): ActionPart | null {
  const token = typeof part === 'string' ? part : part.token
  if (
    typeof token !== 'string' ||
    token.startsWith(CONTROL_TOKEN) ||
    token.startsWith('@') ||
    // Why: a word list can sit in a string or comment state, where the word is just text.
    /^(string|comment|regexp)/.test(token) ||
    !(anyToken || isKeywordToken(token))
  ) {
    return null
  }
  // Why keep the suffix: `keyword.$0` and `keyword.directive` stay distinguishable to themes.
  const flow = isKeywordToken(token) ? CONTROL_TOKEN + token.slice('keyword'.length) : CONTROL_TOKEN
  return typeof part === 'string' ? flow : { ...part, token: flow }
}

/** The words a case key tests the whole match against, or null for any other kind of guard. */
function caseKeyWords(key: string, language: MonarchLanguage): readonly string[] | null {
  const list = /^@(\w+)$/.exec(key)
  if (list) {
    const words: unknown = language[list[1]]
    return Array.isArray(words) && words.every((word) => typeof word === 'string') ? words : null
  }
  // Monarch reads a key of plain words joined by `|` as a word set; any other key is a regex.
  return /^\w+(\|\w+)*$/.test(key) ? key.split('|') : null
}

const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A case key matching exactly `words`: a word set, or an anchored regex when a word has `#` or `-`. */
function wordSetKey(words: readonly string[]): string {
  return words.every((word) => /^\w+$/.test(word))
    ? words.join('|')
    : `(?:${words.map(escapeRegExp).join('|')})`
}

type Rewrite = {
  language: MonarchLanguage
  isControl: (word: string) => boolean
  /** Control words no word set of the grammar lists, still waiting for a word case to take them. */
  unlisted: string[]
  /** A case key for a word list the language did not have, registered as a language attribute. */
  listKey: (words: string[]) => string
}

/** `part` with each word case that tests control words handing them the control token; `part`
 *  itself when it tests no control word. */
function rewriteCases(part: ActionPart, rewrite: Rewrite): ActionPart {
  const cases: Record<string, MonarchAction> = {}
  let changed = false
  for (const [key, value] of caseEntries(part)) {
    const words = caseKeyWords(key, rewrite.language)
    const control = words?.filter(rewrite.isControl) ?? []
    const flow = control.length > 0 && !Array.isArray(value) ? controlPart(value, true) : null
    if (!words || !flow) {
      cases[key] = mapParts(value, (inner) => rewriteCases(inner, rewrite))
      changed ||= cases[key] !== value
      continue
    }
    // Why the first control case also takes unlisted words: a case of their own would cost every
    // other word one more test.
    const unlisted = rewrite.unlisted.splice(0)
    const caseKey = unlisted.length > 0 ? rewrite.listKey([...words, ...unlisted]) : key
    // Why nested under the word's own case: a word in no list (most identifiers) takes exactly the
    // case tests it took before, so the rewrite costs tokenizing nothing.
    cases[caseKey] =
      control.length === words.length && unlisted.length === 0
        ? flow
        : {
            cases: {
              [wordSetKey(control)]: flow,
              ...(unlisted.length > 0 ? { [wordSetKey(unlisted)]: CONTROL_TOKEN } : {}),
              '@default': value
            }
          }
    changed = true
  }
  return changed && typeof part !== 'string' ? { ...part, cases } : part
}

/** The rule's word cases for a member name: keywords read as plain words, other words (builtins)
 *  keep their token, and none changes state. */
function memberAction(part: ActionPart, plainWord: string): ActionPart {
  const cases = caseEntries(part).flatMap(([key, value]): [string, ActionPart][] => {
    const token = typeof value === 'string' ? value : Array.isArray(value) ? null : value.token
    return typeof token === 'string' && !token.startsWith('@')
      ? [[key, { token: isKeywordToken(token) ? plainWord : token, next: '@pop' }]]
      : []
  })
  return { cases: Object.fromEntries(cases) }
}

/** The capture groups of a Monarch regex source, with `@attr` references expanded as Monarch does. */
function groupCount(source: string, language: MonarchLanguage): number {
  const expanded = source.replace(/@(\w+)/g, (ref, attr: string) => {
    const value: unknown = language[attr]
    return value instanceof RegExp
      ? `(?:${value.source})`
      : typeof value === 'string'
        ? `(?:${value})`
        : ref
  })
  return (new RegExp(`${expanded}|`).exec('')?.length ?? 1) - 1
}

type WordRule = { source: string; original: ActionPart; rewritten: ActionPart }

/** `rule` also reading a run of dots right before a word, and sending the word after a lone `.` to
 *  a member state; null when the rule has no plain-word case to give members. */
function withMemberAfterDot(
  rule: WordRule,
  dotToken: string,
  language: MonarchLanguage,
  memberStates: MonarchLanguage['tokenizer']
): { source: string; action: ActionPart } | null {
  const { source, original, rewritten } = rule
  const plainWord = caseEntries(original).find(([key]) => key === '@default')?.[1]
  if (typeof plainWord !== 'string' || typeof rewritten === 'string') {
    return null
  }
  // Why a state per rule: each rule names members with its own word pattern.
  const memberState = `${MEMBER_STATE}${Object.keys(memberStates).length}`
  memberStates[memberState] = [[new RegExp(source), memberAction(original, plainWord)]]
  // Why one rule rather than a dot rule ahead of it: every token tried there would pay one more
  // regex. The dots are the last group so the word is tried first, as before, and the cases' own
  // `$n` keep their numbers; a word then pays one empty-group test.
  const dots = `$${groupCount(source, language) + 1}`
  const dotCase = {
    cases: {
      // Why only a lone dot: after `...` (a spread) or `..` (a range) the word is no member.
      [`${dots}==.`]: { token: dotToken, next: `@${memberState}` },
      '@default': dotToken
    }
  }
  const cases = caseEntries(rewritten).flatMap(([key, value]): [string, MonarchAction][] =>
    key === '@default'
      ? [
          [dots, dotCase],
          [key, value]
        ]
      : [[key, value]]
  )
  return {
    source: `(?:${source})|(\\.+)(?=(?:${source}))`,
    action: { ...rewritten, cases: Object.fromEntries(cases) }
  }
}

type RuleParts = {
  source: string
  action: MonarchAction
  rebuild: (source: string, action: MonarchAction) => MonarchRule
}

/** A rule's regex source and action in either Monarch rule form; null for includes. */
function ruleParts(rule: MonarchRule): RuleParts | null {
  if (Array.isArray(rule)) {
    const [regex, action, ...rest] = rule
    const source = regex instanceof RegExp ? regex.source : regex
    // Why: Monaco's rule types promise an action, but some grammars ship `[regex]` alone.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- SAFETY: see above.
    if (action === undefined) {
      return null
    }
    return {
      source,
      action,
      rebuild: (nextSource, next) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same shape as `rule`, with only its regex and action replaced.
        [nextSource === source ? regex : nextSource, next, ...rest] as MonarchRule
    }
  }
  if (!('regex' in rule) || rule.action === undefined || rule.regex === undefined) {
    return null
  }
  const { regex } = rule
  const source = regex instanceof RegExp ? regex.source : regex
  return {
    source,
    action: rule.action,
    rebuild: (nextSource, next) => ({
      ...rule,
      regex: nextSource === source ? regex : nextSource,
      action: next
    })
  }
}

function listedWords(language: MonarchLanguage, normalize: (word: string) => string): Set<string> {
  const listed = new Set<string>()
  const visit = (part: ActionPart): ActionPart => {
    for (const [key, value] of caseEntries(part)) {
      caseKeyWords(key, language)?.forEach((word) => listed.add(normalize(word)))
      mapParts(value, visit)
    }
    return part
  }
  for (const rule of Object.values(language.tokenizer).flat()) {
    const parts = ruleParts(rule)
    if (parts) {
      mapParts(parts.action, visit)
    }
  }
  return listed
}

/** A Monaco Monarch language that tokenizes `spec`'s control keywords as `keyword.flow`, keeping
 *  every other token, state change and bracket of the original. */
export function withControlKeywords(
  language: MonarchLanguage,
  spec: ControlKeywordSpec
): MonarchLanguage {
  const normalize = (word: string): string => (language.ignoreCase ? word.toLowerCase() : word)
  const control = (spec.keywords ?? '').split(/\s+/).filter(Boolean)
  const controlSet = new Set(control.map(normalize))
  const listed = listedWords(language, normalize)
  const unlisted = control.filter((word) => !listed.has(normalize(word)))
  const lists: Record<string, string[]> = {}
  const listKey = (words: string[]): string => {
    const name = `${LIST_ATTRIBUTE}${Object.keys(lists).length}`
    lists[name] = words
    return `@${name}`
  }
  const isControl = (word: string): boolean => controlSet.has(normalize(word))
  const tokenizer: MonarchLanguage['tokenizer'] = {}
  const memberStates: MonarchLanguage['tokenizer'] = {}
  for (const [state, rules] of Object.entries(language.tokenizer)) {
    tokenizer[state] = rules.map((rule) => {
      const parts = ruleParts(rule)
      if (!parts) {
        return rule
      }
      const { source, action } = parts
      // Why a copy of `unlisted` per rule: every word rule needs a case for them.
      const rewrite: Rewrite = { language, isControl, unlisted: [...unlisted], listKey }
      const rewritten = spec.controlRules?.test(source)
        ? mapParts(action, (part) => controlPart(part, false) ?? part)
        : mapParts(action, (part) => rewriteCases(part, rewrite))
      if (rewritten === action) {
        return rule
      }
      const member =
        spec.memberAfterDot !== undefined && !Array.isArray(action) && !Array.isArray(rewritten)
          ? withMemberAfterDot(
              { source, original: action, rewritten },
              spec.memberAfterDot,
              language,
              memberStates
            )
          : null
      return member ? parts.rebuild(member.source, member.action) : parts.rebuild(source, rewritten)
    })
  }
  return { ...language, ...lists, tokenizer: { ...tokenizer, ...memberStates } }
}
