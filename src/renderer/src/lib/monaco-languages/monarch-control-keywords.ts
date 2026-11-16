import type * as Monaco from 'monaco-editor'

type MonarchLanguage = Monaco.languages.IMonarchLanguage
type MonarchRule = Monaco.languages.IMonarchLanguageRule
type MonarchAction = Monaco.languages.IMonarchLanguageAction
type ActionPart = string | Monaco.languages.IExpandedMonarchLanguageAction

// Why `keyword.flow`: Monaco's stock themes color it as VS Code themes color `keyword.control`,
// and plugin themes resolve it through their `keyword.control` rule.
const CONTROL_TOKEN = 'keyword.flow'
const MEMBER_STATE = 'orcaControlKeywordMember'

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
  /** Control words no word set of the grammar lists, as a case key, or null when there are none. */
  unlistedKey: string | null
}

/** `part` with its word cases split so control words get the control token; `part` itself when
 *  it tests no control word. */
function rewriteCases(part: ActionPart, rewrite: Rewrite): ActionPart {
  const cases: Record<string, MonarchAction> = {}
  let changed = false
  let isKeywordRule = false
  for (const [key, value] of caseEntries(part)) {
    const words = caseKeyWords(key, rewrite.language)
    const control = words?.filter(rewrite.isControl) ?? []
    const flow = control.length > 0 && !Array.isArray(value) ? controlPart(value, true) : null
    isKeywordRule ||= flow !== null
    // Why before the plain-word case: control words the grammar never listed still need a case.
    if (key === '@default' && isKeywordRule && rewrite.unlistedKey) {
      cases[rewrite.unlistedKey] = CONTROL_TOKEN
    }
    if (flow && control.length === words?.length) {
      cases[key] = flow
    } else {
      if (flow) {
        // Why before the original key: Monarch takes the first matching case, so order is precedence.
        cases[wordSetKey(control)] = flow
      }
      cases[key] = mapParts(value, (inner) => rewriteCases(inner, rewrite))
    }
    changed ||= flow !== null || cases[key] !== value
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

/** Ahead of a rule that tokenizes words, a rule that reads a word right after a lone `.` as a
 *  member; none when the rule has no plain-word case to give members. */
function memberRules(
  source: string,
  part: ActionPart,
  dotToken: string,
  memberStates: MonarchLanguage['tokenizer']
): MonarchRule[] {
  const plainWord = caseEntries(part).find(([key]) => key === '@default')?.[1]
  if (typeof plainWord !== 'string') {
    return []
  }
  // Why a state per rule: each rule names members with its own identifier pattern.
  const memberState = `${MEMBER_STATE}${Object.keys(memberStates).length}`
  memberStates[memberState] = [[new RegExp(source), memberAction(part, plainWord)]]
  return [
    [
      new RegExp(`\\.+(?=${source})`),
      {
        cases: {
          // Why only a lone dot: after `...` (a spread) or `..` (a range) the word is no member.
          '$0==.': { token: dotToken, next: `@${memberState}` },
          '@default': dotToken
        }
      }
    ]
  ]
}

type RuleParts = {
  source: string
  action: MonarchAction
  withAction: (action: MonarchAction) => MonarchRule
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same shape as `rule`, with only its action replaced.
      withAction: (next) => [regex, next, ...rest] as MonarchRule
    }
  }
  if (!('regex' in rule) || rule.action === undefined || rule.regex === undefined) {
    return null
  }
  return {
    source: rule.regex instanceof RegExp ? rule.regex.source : rule.regex,
    action: rule.action,
    withAction: (next) => ({ ...rule, action: next })
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
  const rewrite: Rewrite = {
    language,
    isControl: (word) => controlSet.has(normalize(word)),
    unlistedKey: unlisted.length > 0 ? wordSetKey(unlisted) : null
  }
  const tokenizer: MonarchLanguage['tokenizer'] = {}
  const memberStates: MonarchLanguage['tokenizer'] = {}
  for (const [state, rules] of Object.entries(language.tokenizer)) {
    tokenizer[state] = rules.flatMap((rule): MonarchRule[] => {
      const parts = ruleParts(rule)
      if (!parts) {
        return [rule]
      }
      const { source, action } = parts
      const rewritten = spec.controlRules?.test(source)
        ? mapParts(action, (part) => controlPart(part, false) ?? part)
        : mapParts(action, (part) => rewriteCases(part, rewrite))
      if (rewritten === action) {
        return [rule]
      }
      const members =
        spec.memberAfterDot !== undefined && !Array.isArray(action)
          ? memberRules(source, action, spec.memberAfterDot, memberStates)
          : []
      return [...members, parts.withAction(rewritten)]
    })
  }
  return { ...language, tokenizer: { ...tokenizer, ...memberStates } }
}
