const MOBILE_WEB_JSON_DEPTH_LIMIT = 32

export function isExactMobileWebJsonDocument(value: string): boolean {
  return new MobileWebExactJsonParser(value).parse()
}

class MobileWebExactJsonParser {
  private index = 0

  constructor(private readonly value: string) {}

  parse(): boolean {
    this.skipWhitespace()
    if (!this.parseValue(0)) {
      return false
    }
    this.skipWhitespace()
    return this.index === this.value.length
  }

  private parseValue(depth: number): boolean {
    if (depth > MOBILE_WEB_JSON_DEPTH_LIMIT || this.index >= this.value.length) {
      return false
    }
    const character = this.value[this.index]
    if (character === '{') {
      return this.parseObject(depth)
    }
    if (character === '[') {
      return this.parseArray(depth)
    }
    if (character === '"') {
      return this.parseStringLiteral() !== null
    }
    if (character === 't') {
      return this.consumeText('true')
    }
    if (character === 'f') {
      return this.consumeText('false')
    }
    if (character === 'n') {
      return this.consumeText('null')
    }
    return this.parseNumber()
  }

  private parseObject(depth: number): boolean {
    if (!this.consumeCharacter('{')) {
      return false
    }
    this.skipWhitespace()
    if (this.consumeCharacter('}')) {
      return true
    }
    const keys = new Set<string>()
    while (true) {
      const literal = this.parseStringLiteral()
      const key = literal === null ? null : decodeJsonString(literal)
      if (key === null || keys.has(key)) {
        return false
      }
      keys.add(key)
      this.skipWhitespace()
      if (!this.consumeCharacter(':')) {
        return false
      }
      this.skipWhitespace()
      if (!this.parseValue(depth + 1)) {
        return false
      }
      this.skipWhitespace()
      if (this.consumeCharacter('}')) {
        return true
      }
      if (!this.consumeCharacter(',')) {
        return false
      }
      this.skipWhitespace()
    }
  }

  private parseArray(depth: number): boolean {
    if (!this.consumeCharacter('[')) {
      return false
    }
    this.skipWhitespace()
    if (this.consumeCharacter(']')) {
      return true
    }
    while (true) {
      if (!this.parseValue(depth + 1)) {
        return false
      }
      this.skipWhitespace()
      if (this.consumeCharacter(']')) {
        return true
      }
      if (!this.consumeCharacter(',')) {
        return false
      }
      this.skipWhitespace()
    }
  }

  private parseStringLiteral(): string | null {
    if (!this.consumeCharacter('"')) {
      return null
    }
    const start = this.index - 1
    while (this.index < this.value.length) {
      const codeUnit = this.value.charCodeAt(this.index)
      const character = this.value[this.index]
      this.index += 1
      if (character === '"') {
        return this.value.slice(start, this.index)
      }
      if (codeUnit < 0x20) {
        return null
      }
      if (isHighSurrogate(codeUnit)) {
        if (this.index >= this.value.length || !isLowSurrogate(this.value.charCodeAt(this.index))) {
          return null
        }
        this.index += 1
        continue
      }
      if (isLowSurrogate(codeUnit)) {
        return null
      }
      if (character !== '\\') {
        continue
      }
      if (this.index >= this.value.length) {
        return null
      }
      const escaped = this.value[this.index]
      this.index += 1
      if (escaped !== 'u') {
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
          return null
        }
        continue
      }
      const escapedCodeUnit = this.parseUnicodeCodeUnit()
      if (escapedCodeUnit === null) {
        return null
      }
      if (isHighSurrogate(escapedCodeUnit)) {
        if (!this.consumeText('\\u')) {
          return null
        }
        const lowSurrogate = this.parseUnicodeCodeUnit()
        if (lowSurrogate === null || !isLowSurrogate(lowSurrogate)) {
          return null
        }
      } else if (isLowSurrogate(escapedCodeUnit)) {
        return null
      }
    }
    return null
  }

  private parseUnicodeCodeUnit(): number | null {
    if (this.index + 4 > this.value.length) {
      return null
    }
    let codeUnit = 0
    for (let digitIndex = 0; digitIndex < 4; digitIndex += 1) {
      const digit = hexValue(this.value.charCodeAt(this.index))
      this.index += 1
      if (digit === null) {
        return null
      }
      codeUnit = (codeUnit << 4) | digit
    }
    return codeUnit
  }

  private parseNumber(): boolean {
    const start = this.index
    this.consumeCharacter('-')
    if (this.index >= this.value.length) {
      return false
    }
    if (this.consumeCharacter('0')) {
      if (this.index < this.value.length && isJsonDigit(this.value.charCodeAt(this.index))) {
        return false
      }
    } else if (!this.consumeDigits(true)) {
      return false
    }
    if (this.consumeCharacter('.') && !this.consumeDigits(false)) {
      return false
    }
    if (this.index < this.value.length && 'eE'.includes(this.value[this.index] ?? '')) {
      this.index += 1
      if (this.index < this.value.length && '+-'.includes(this.value[this.index] ?? '')) {
        this.index += 1
      }
      if (!this.consumeDigits(false)) {
        return false
      }
    }
    return this.index > start
  }

  private consumeDigits(firstMustBeNonzero: boolean): boolean {
    if (this.index >= this.value.length) {
      return false
    }
    const first = this.value.charCodeAt(this.index)
    if (
      (firstMustBeNonzero && (first < 0x31 || first > 0x39)) ||
      (!firstMustBeNonzero && !isJsonDigit(first))
    ) {
      return false
    }
    this.index += 1
    while (this.index < this.value.length && isJsonDigit(this.value.charCodeAt(this.index))) {
      this.index += 1
    }
    return true
  }

  private consumeText(expected: string): boolean {
    if (!this.value.startsWith(expected, this.index)) {
      return false
    }
    this.index += expected.length
    return true
  }

  private consumeCharacter(expected: string): boolean {
    if (this.value[this.index] !== expected) {
      return false
    }
    this.index += 1
    return true
  }

  private skipWhitespace(): void {
    while (this.index < this.value.length && ' \t\n\r'.includes(this.value[this.index] ?? '')) {
      this.index += 1
    }
  }
}

function decodeJsonString(literal: string): string | null {
  try {
    const value: unknown = JSON.parse(literal)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function hexValue(codeUnit: number): number | null {
  if (codeUnit >= 0x30 && codeUnit <= 0x39) {
    return codeUnit - 0x30
  }
  if (codeUnit >= 0x41 && codeUnit <= 0x46) {
    return codeUnit - 0x41 + 10
  }
  if (codeUnit >= 0x61 && codeUnit <= 0x66) {
    return codeUnit - 0x61 + 10
  }
  return null
}

function isJsonDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}
