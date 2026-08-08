import { normalizeSpeechHotwords } from './speech-hotwords'
import type { DictationCorrectionMode } from './speech-types'

export const MAX_DICTATION_CORRECTION_CODE_UNITS = 100_000

const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const REGEXP_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g
const VOCABULARY_SEPARATOR_RE = /[\s._-]/u
const VOCABULARY_SEGMENT_BREAK = '\0'

const CHINESE_SPOKEN_PUNCTUATION = [
  ['换一行', '\n'],
  ['下一行', '\n'],
  ['换行', '\n'],
  ['左括号', '（'],
  ['右括号', '）'],
  ['问号', '？'],
  ['感叹号', '！'],
  ['叹号', '！'],
  ['逗号', '，'],
  ['句号', '。'],
  ['冒号', '：'],
  ['分号', '；']
] as const

const ENGLISH_SPOKEN_PUNCTUATION = [
  ['new paragraph', '\n\n'],
  ['new line', '\n'],
  ['open parenthesis', '('],
  ['close parenthesis', ')'],
  ['question mark', '?'],
  ['exclamation mark', '!'],
  ['full stop', '.'],
  ['semicolon', ';'],
  ['comma', ','],
  ['period', '.'],
  ['colon', ':']
] as const

export function normalizeDictationCorrectionMode(value: unknown): DictationCorrectionMode {
  return value === 'preview' || value === 'auto' ? value : 'off'
}

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIAL_RE, '\\$&')
}

function replaceSpokenPunctuation(text: string): string {
  let corrected = text
  for (const [spoken, punctuation] of CHINESE_SPOKEN_PUNCTUATION) {
    corrected = corrected.replaceAll(spoken, punctuation)
  }
  for (const [spoken, punctuation] of ENGLISH_SPOKEN_PUNCTUATION) {
    const pattern = escapeRegExp(spoken).replaceAll(' ', '\\s+')
    corrected = corrected.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])(?:${pattern})(?=$|[^\\p{L}\\p{N}])`, 'giu'),
      (_match, prefix: string) => `${prefix}${punctuation}`
    )
  }
  return corrected
}

function getVocabularyKey(term: string): string | null {
  const characters = Array.from(term.normalize('NFKC')).filter((character) =>
    LETTER_OR_NUMBER_RE.test(character)
  )
  if (characters.length < 2 || characters.some((character) => CJK_RE.test(character))) {
    return null
  }
  return characters.join('').toLowerCase()
}

type VocabularyTrieNode = {
  children: Map<string, VocabularyTrieNode>
  term?: string
}

function buildVocabularyTrie(vocabulary: readonly string[]): VocabularyTrieNode {
  const root: VocabularyTrieNode = { children: new Map() }
  for (const term of normalizeSpeechHotwords(vocabulary)) {
    const key = getVocabularyKey(term)
    if (!key) {
      continue
    }
    let node = root
    for (let index = 0; index < key.length; index += 1) {
      const character = key[index]
      let child = node.children.get(character)
      if (!child) {
        child = { children: new Map() }
        node.children.set(character, child)
      }
      node = child
    }
    node.term ??= term
  }
  return root
}

type SearchableTranscript = {
  foldedText: string
  sourceStarts: number[]
  sourceEnds: number[]
  startsAtBoundary: boolean[]
  endsAtBoundary: boolean[]
}

function buildSearchableTranscript(text: string): SearchableTranscript {
  let foldedText = ''
  const sourceStarts: number[] = []
  const sourceEnds: number[] = []
  const startsAtBoundary: boolean[] = []
  const endsAtBoundary: boolean[] = []
  let previousWasLetterOrNumber = false

  for (let sourceStart = 0; sourceStart < text.length; ) {
    const character = String.fromCodePoint(text.codePointAt(sourceStart) ?? 0)
    const sourceEnd = sourceStart + character.length
    const isLetterOrNumber = LETTER_OR_NUMBER_RE.test(character)
    if (isLetterOrNumber) {
      const nextCharacter =
        sourceEnd < text.length ? String.fromCodePoint(text.codePointAt(sourceEnd) ?? 0) : ''
      const foldedCharacter = character.toLowerCase()
      for (let index = 0; index < foldedCharacter.length; index += 1) {
        foldedText += foldedCharacter[index]
        sourceStarts.push(sourceStart)
        sourceEnds.push(sourceEnd)
        startsAtBoundary.push(index === 0 && !previousWasLetterOrNumber)
        endsAtBoundary.push(
          index === foldedCharacter.length - 1 && !LETTER_OR_NUMBER_RE.test(nextCharacter)
        )
      }
    } else if (!VOCABULARY_SEPARATOR_RE.test(character)) {
      foldedText += VOCABULARY_SEGMENT_BREAK
      sourceStarts.push(sourceStart)
      sourceEnds.push(sourceEnd)
      startsAtBoundary.push(false)
      endsAtBoundary.push(false)
    }
    previousWasLetterOrNumber = isLetterOrNumber
    sourceStart = sourceEnd
  }

  return { foldedText, sourceStarts, sourceEnds, startsAtBoundary, endsAtBoundary }
}

function restoreVocabularyTerms(text: string, vocabulary: readonly string[]): string {
  const trie = buildVocabularyTrie(vocabulary)
  if (trie.children.size === 0) {
    return text
  }
  const searchable = buildSearchableTranscript(text)
  const replacements: { start: number; end: number; term: string }[] = []

  for (let start = 0; start < searchable.foldedText.length; start += 1) {
    if (!searchable.startsAtBoundary[start]) {
      continue
    }
    let node: VocabularyTrieNode | undefined = trie
    let bestMatch: { end: number; term: string } | null = null
    for (let end = start; end < searchable.foldedText.length; end += 1) {
      node = node.children.get(searchable.foldedText[end])
      if (!node) {
        break
      }
      if (node.term && searchable.endsAtBoundary[end]) {
        bestMatch = { end, term: node.term }
      }
    }
    if (!bestMatch) {
      continue
    }
    replacements.push({
      start: searchable.sourceStarts[start],
      end: searchable.sourceEnds[bestMatch.end],
      term: bestMatch.term
    })
    start = bestMatch.end
  }

  if (replacements.length === 0) {
    return text
  }
  let sourceIndex = 0
  let corrected = ''
  for (const replacement of replacements) {
    corrected += text.slice(sourceIndex, replacement.start) + replacement.term
    sourceIndex = replacement.end
  }
  return corrected + text.slice(sourceIndex)
}

function stripTranscriptControlCharacters(text: string): string {
  let result = ''
  for (const character of text) {
    const code = character.charCodeAt(0)
    if ((code <= 0x1f && character !== '\n' && character !== '\t') || code === 0x7f) {
      continue
    }
    result += character
  }
  return result
}

function normalizeTranscriptSpacing(text: string): string {
  return stripTranscriptControlCharacters(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([,.;!?%。，、！？；：)\]}》」』])/gu, '$1')
    .replace(/(\[|[({（【《「『]) +/gu, '$1')
    .replace(/([，。！？；：、]) +/gu, '$1')
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]) +(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu,
      '$1'
    )
    .trim()
}

export function correctSpeechTranscript(text: string, vocabulary: readonly string[] = []): string {
  const rawText = text.trim()
  if (!rawText || rawText.length > MAX_DICTATION_CORRECTION_CODE_UNITS) {
    return rawText
  }
  return normalizeTranscriptSpacing(
    restoreVocabularyTerms(replaceSpokenPunctuation(rawText), vocabulary)
  )
}
