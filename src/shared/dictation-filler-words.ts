// Sounds people make while thinking, per language. Never words with meaning ("like", "so", "well", "那个", "그").
const FILLERS_BY_LANGUAGE: Record<string, string> = {
  en: 'u+m+|u+h+m*|er|e+r+m+|h+m+|m{3,}',
  de: 'ä+h+m*|ö+h+m*|e+h+m+|h+m+|m{3,}',
  es: 'e+h{2,}|e+h+m+|e+m+|h+m+|m{3,}',
  fr: 'e+u+h+|h+e+u+|h+u+m+|h+m+|m{3,}',
  it: 'e+h{2,}|e+h+m+|u+h+m+|h+m+|m{3,}',
  pt: 'h+ã+|ã+h+|h+u+m+|h+m+|m{3,}',
  nl: 'e+h+m*|u+h+m*|h+m+|m{3,}',
  ru: 'э+м*|х+м+|м{3,}',
  ja: 'え[ーえっ]*と|えー+|あのー+|うー+ん|んー+',
  ko: '으*음+|흠+',
  // 嗯 alone is also "yes", so only the one a pause follows goes.
  zh: '嗯+(?=\\s*[，,、])|呃+|[额額]+'
}
FILLERS_BY_LANGUAGE.yue = FILLERS_BY_LANGUAGE.zh

// For an unknown language: English fillers that are no word elsewhere ("um" is German and Portuguese, "er" German).
const LANGUAGE_NEUTRAL_FILLERS = 'u+h+m*|u+m{2,}|e+r+m+|h+m+|m{3,}'

const WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}_/'\u2019\-]`
// A filler stands alone: nothing joins it to a word (a dot only does inside a name like "um.txt"),
// and "hm?" or "eh!" is a question or a call, so it stays.
const standalone = (fillers: string): string =>
  String.raw`(?<!${WORD_CHAR}|${WORD_CHAR}\.)(${fillers})(?!${WORD_CHAR}|\.${WORD_CHAR})(?!\s*[?\uFF1F!\uFF01])`
// The comma or ellipsis after a filler goes with it.
const TRAILING_PAUSE = String.raw`(?:\s*(?<pause>[,\uFF0C\u3001\u2026]|\.{3}))?\s*`
const SENTENCE_END_CHARS = '.!?。！？'
const SENTENCE_END_RE = new RegExp(`^[${SENTENCE_END_CHARS}]+\\s*`, 'u')
// A comma left in front of a removed filler that ended the sentence or the text.
const TRAILING_SOFT_PUNCTUATION_RE = /[\s,\uFF0C\u3001]+$/u
// The comma before a filler that a pause also follows, keeping the space after it.
const COMMA_BEFORE_PAUSED_FILLER_RE = /[,\uFF0C\u3001](\s*)$/u
const NON_LATIN_LETTER_RE = /(?=\p{L})\P{Script=Latin}/u

function fillerPattern(languages: readonly string[] | undefined, text: string): RegExp | null {
  const lists = (languages ?? []).flatMap((language) => FILLERS_BY_LANGUAGE[language] ?? [])
  if (lists.length === 0) {
    if (NON_LATIN_LETTER_RE.test(text)) {
      return null
    }
    lists.push(LANGUAGE_NEUTRAL_FILLERS)
  }
  return new RegExp(standalone(lists.join('|')) + TRAILING_PAUSE, 'giu')
}

// In mixed-case text an all-caps "UM" or "HMM" is more likely a name or acronym than a sound.
function isAllCaps(word: string): boolean {
  return word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()
}

function capitalizeLowercaseWord(text: string): string {
  const word = /^\p{L}+/u.exec(text)?.[0]
  if (!word || word !== word.toLowerCase()) {
    return text
  }
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Drops standalone filler sounds and the pause punctuation after them; text with none comes back unchanged. */
export function removeFillerWords(text: string, languages: readonly string[] | undefined): string {
  const pattern = fillerPattern(languages, text)
  if (!pattern) {
    return text
  }
  let out = ''
  let cursor = 0
  let capitalizeNext = false
  // Some models write everything in capitals, where "UM" is still a sound.
  const caseless = text === text.toUpperCase()
  const keep = (segment: string): void => {
    if (segment) {
      out += capitalizeNext ? capitalizeLowercaseWord(segment) : segment
      capitalizeNext = false
    }
  }
  for (const match of text.matchAll(pattern)) {
    const filler = match[1]
    if (!caseless && isAllCaps(filler)) {
      continue
    }
    keep(text.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const before = out.trimEnd()
    const atSentenceStart = before === '' || SENTENCE_END_CHARS.includes(before.slice(-1))
    const sentenceEnd = SENTENCE_END_RE.exec(text.slice(cursor))
    // "we should, um." keeps its full stop; "Um." on its own goes entirely.
    if (sentenceEnd && atSentenceStart) {
      cursor += sentenceEnd[0].length
    } else if (sentenceEnd) {
      out = out.replace(TRAILING_SOFT_PUNCTUATION_RE, '')
    } else if (match.groups?.pause) {
      // "we should, uh, ship" set the filler off on both sides; neither comma belongs to the sentence.
      out = out.replace(COMMA_BEFORE_PAUSED_FILLER_RE, '$1')
    }
    // Only a capitalised "Um" began a sentence the next word now begins.
    capitalizeNext ||= atSentenceStart && filler.charAt(0) !== filler.charAt(0).toLowerCase()
  }
  if (cursor === 0) {
    return text
  }
  if (cursor === text.length) {
    // A filler at the very end leaves the comma before it dangling.
    out = out.replace(TRAILING_SOFT_PUNCTUATION_RE, '')
  } else {
    keep(text.slice(cursor))
  }
  return out.trim()
}
