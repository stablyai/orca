import type * as Monaco from 'monaco-editor'

type MonarchLanguage = Monaco.languages.IMonarchLanguage
type MonarchRule = Monaco.languages.IMonarchLanguageRule
type MonarchAction = Monaco.languages.IMonarchLanguageAction
type ActionPart = string | Monaco.languages.IExpandedMonarchLanguageAction

// Why these names: Monaco's stock themes color `keyword.flow` as TextMate themes color
// `keyword.control`, and plugin themes resolve both through their TextMate scope rules.
const CONTROL_TOKEN = 'keyword.flow'
const CALL_TOKEN = 'function'

/** The token names these refinements emit, by the TextMate scope each stands for. Plugin themes
 *  and plugin syntaxes reach them through that scope, so a plugin sees the same names on core and
 *  plugin languages. */
export const REFINED_TOKEN_SCOPES: Record<string, string> = {
  [CONTROL_TOKEN]: 'keyword.control',
  [CALL_TOKEN]: 'entity.name.function'
}

/** Stock Dark and Light colors for the token names these refinements add that Monaco's own stock
 *  themes leave plain, as TextMate's Dark+ and Light+ color `entity.name.function`. */
export const REFINED_TOKEN_STOCK_RULES: Record<'dark' | 'light', Monaco.editor.ITokenThemeRule[]> =
  {
    dark: [{ token: CALL_TOKEN, foreground: 'DCDCAA' }],
    light: [{ token: CALL_TOKEN, foreground: '795E26' }]
  }
const MEMBER_STATE = 'orcaControlKeywordMember'
const LIST_ATTRIBUTE = 'orcaControlKeywordWords'

export type TokenRefinementSpec = {
  /** Space-separated words the language's TextMate grammar scopes `keyword.control`. */
  controlWords?: string
  /** Rules, by regex source, whose keyword tokens are all control keywords (`#include`, `@import`). */
  controlRules?: RegExp
  /** The token the language gives `.`, for languages where a keyword right after it names a
   *  member (`promise.catch()`, `re.match()`), which then keeps the language's plain-word token. */
  memberAfterDot?: string
  /** Whether a plain word right before `(` is a function call or definition (`foo(`, `a.then(`). */
  calls?: boolean
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

/** The rule's word cases for a member name: keywords read as plain words (`plain`), other words
 *  (builtins) keep their token, and none changes state. */
function memberAction(part: ActionPart, plain: ActionPart): ActionPart {
  const cases = caseEntries(part).flatMap(([key, value]): [string, ActionPart][] => {
    const token = typeof value === 'string' ? value : Array.isArray(value) ? null : value.token
    if (typeof token !== 'string' || token.startsWith('@')) {
      return []
    }
    return [[key, key === '@default' || isKeywordToken(token) ? plain : { token, next: '@pop' }]]
  })
  return { cases: Object.fromEntries(cases) }
}

/** The token an identifier rule gives words in no list: a rule testing words (not operators) with
 *  plain-token cases and no group actions, which extra groups in its regex would break. */
function plainWordToken(part: ActionPart, language: MonarchLanguage): string | null {
  const cases = caseEntries(part)
  const plain = cases.find(([key]) => key === '@default')?.[1]
  const testsWords = cases.some(([key]) => caseKeyWords(key, language)?.some((w) => /^\w/.test(w)))
  return typeof plain === 'string' &&
    (plain === '' || /^identifier(\.|$)/.test(plain)) &&
    testsWords &&
    !cases.some(([, value]) => Array.isArray(value))
    ? plain
    : null
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

type WordContext = {
  spec: TokenRefinementSpec
  language: MonarchLanguage
  memberStates: MonarchLanguage['tokenizer']
}

/** A word rule that also reads what follows and precedes a word, for `spec.calls` and
 *  `spec.memberAfterDot`; null when `spec` asks for neither or `original` is no identifier rule.
 *  Why one rule: a rule of its own ahead of this one would cost every token one more regex. The
 *  context is in optional groups after the rule's own, so a word is tried first as before, the
 *  cases' own `$n` keep their numbers, and a word pays only empty-group tests. */
function withWordContext(
  rule: { source: string; original: ActionPart; rewritten: ActionPart },
  { spec, language, memberStates }: WordContext
): { source: string; action: ActionPart } | null {
  const { source, original, rewritten } = rule
  const plainWord = plainWordToken(original, language)
  if (
    plainWord === null ||
    typeof rewritten === 'string' ||
    !(spec.calls || spec.memberAfterDot !== undefined)
  ) {
    return null
  }
  const groups = groupCount(source, language)
  const word = `(?:${source})${spec.calls ? '(?=(\\s*\\()?)' : ''}`
  const call = `$${groups + 1}`
  const plain = (next?: string): ActionPart => {
    const token = { token: plainWord, ...(next ? { next } : {}) }
    return spec.calls
      ? { cases: { [call]: { ...token, token: CALL_TOKEN }, '@default': token } }
      : token
  }
  const context: [string, MonarchAction][] = spec.calls ? [[call, plain()]] : []
  let memberSource = ''
  if (spec.memberAfterDot !== undefined) {
    // Why a state per rule: each rule names members with its own word pattern.
    const memberState = `${MEMBER_STATE}${Object.keys(memberStates).length}`
    memberStates[memberState] = [[new RegExp(word), memberAction(original, plain('@pop'))]]
    const dots = `$${groups + (spec.calls ? 2 : 1)}`
    context.unshift([
      dots,
      {
        cases: {
          // Why only a lone dot: after `...` (a spread) or `..` (a range) the word is no member.
          [`${dots}==.`]: { token: spec.memberAfterDot, next: `@${memberState}` },
          '@default': spec.memberAfterDot
        }
      }
    ])
    memberSource = `|(\\.+)(?=(?:${source}))`
  }
  const cases = caseEntries(rewritten).flatMap(([key, value]): [string, MonarchAction][] =>
    key === '@default' ? [...context, [key, value]] : [[key, value]]
  )
  return { source: word + memberSource, action: { ...rewritten, cases: Object.fromEntries(cases) } }
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

/** A Monaco Monarch language that tokenizes `spec`'s control keywords as `keyword.flow` and, with
 *  `spec.calls`, called words as `function`, keeping every other token, state change and bracket. */
export function withTokenRefinements(
  language: MonarchLanguage,
  spec: TokenRefinementSpec
): MonarchLanguage {
  const normalize = (word: string): string => (language.ignoreCase ? word.toLowerCase() : word)
  const control = (spec.controlWords ?? '').split(/\s+/).filter(Boolean)
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
      const word =
        Array.isArray(action) || Array.isArray(rewritten)
          ? null
          : withWordContext(
              { source, original: action, rewritten },
              { spec, language, memberStates }
            )
      if (word) {
        return parts.rebuild(word.source, word.action)
      }
      return rewritten === action ? rule : parts.rebuild(source, rewritten)
    })
  }
  return { ...language, ...lists, tokenizer: { ...tokenizer, ...memberStates } }
}
