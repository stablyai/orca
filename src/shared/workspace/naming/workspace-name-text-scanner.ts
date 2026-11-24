export function foldWorkspaceNameWhitespaceToHyphen(input: string): string {
  let result = ''
  let pendingHyphen = false
  for (let index = 0; index < input.length; index += 1) {
    if (isWorkspaceNameWhitespace(input.charCodeAt(index))) {
      pendingHyphen = true
      continue
    }
    if (pendingHyphen) {
      result += '-'
      pendingHyphen = false
    }
    result += input[index]
  }
  return result
}

export function collectCompactWorkspaceWords(
  input: string,
  maxWords: number,
  stopWords: ReadonlySet<string>
): string[] {
  const words: string[] = []
  let tokenStart = -1
  for (let index = 0; index <= input.length; index += 1) {
    const isEnd = index === input.length
    if (!isEnd && startsWithHttpUrl(input, index)) {
      index = finishCompactWorkspaceToken(input, tokenStart, index, words, maxWords, stopWords)
      tokenStart = -1
      while (index < input.length && !isWorkspaceNameWhitespace(input.charCodeAt(index))) {
        index += 1
      }
      if (words.length >= maxWords) {
        break
      }
      continue
    }
    if (!isEnd && !isCompactWorkspaceWordSeparator(input.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      finishCompactWorkspaceToken(input, tokenStart, index, words, maxWords, stopWords)
      tokenStart = -1
      if (words.length >= maxWords) {
        break
      }
    }
  }
  return words
}

function finishCompactWorkspaceToken(
  input: string,
  tokenStart: number,
  tokenEnd: number,
  words: string[],
  maxWords: number,
  stopWords: ReadonlySet<string>
): number {
  if (tokenStart === -1 || words.length >= maxWords) {
    return tokenEnd
  }
  const word = input.slice(tokenStart, tokenEnd)
  if (word && !stopWords.has(word.toLowerCase())) {
    words.push(word)
  }
  return tokenEnd
}

function startsWithHttpUrl(input: string, index: number): boolean {
  return (
    startsWithAsciiInsensitive(input, index, 'http://') ||
    startsWithAsciiInsensitive(input, index, 'https://')
  )
}

function startsWithAsciiInsensitive(input: string, index: number, prefix: string): boolean {
  if (index + prefix.length > input.length) {
    return false
  }
  for (let offset = 0; offset < prefix.length; offset += 1) {
    if (toLowerAsciiCode(input.charCodeAt(index + offset)) !== prefix.charCodeAt(offset)) {
      return false
    }
  }
  return true
}

function toLowerAsciiCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function isCompactWorkspaceWordSeparator(code: number): boolean {
  return (
    isWorkspaceNameWhitespace(code) ||
    code === 34 ||
    code === 35 ||
    code === 40 ||
    code === 41 ||
    code === 47 ||
    code === 58 ||
    code === 91 ||
    code === 92 ||
    code === 93 ||
    code === 95 ||
    code === 123 ||
    code === 125 ||
    code === 45
  )
}

function isWorkspaceNameWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
