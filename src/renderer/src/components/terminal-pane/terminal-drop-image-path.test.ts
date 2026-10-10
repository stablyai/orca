import { describe, expect, it } from 'vitest'
import {
  canPasteImageDropPathRaw,
  formatImageDropPasteText,
  isImageDropPath
} from './terminal-drop-image-path'

describe('isImageDropPath', () => {
  it('detects common image extensions case-insensitively', () => {
    for (const path of [
      '/repo/shot.png',
      '/repo/shot.PNG',
      '/repo/a.jpg',
      '/repo/a.jpeg',
      '/repo/a.gif',
      '/repo/icon.svg',
      '/repo/a.webp',
      '/repo/a.bmp',
      '/repo/a.ico',
      'C:\\Users\\me\\Pictures\\diagram.PnG'
    ]) {
      expect(isImageDropPath(path)).toBe(true)
    }
  })

  it('rejects non-image and extension-less paths', () => {
    for (const path of [
      '/repo/index.ts',
      '/repo/notes.md',
      '/repo/archive.tar.gz',
      '/repo/Makefile',
      '/repo/.gitignore'
    ]) {
      expect(isImageDropPath(path)).toBe(false)
    }
  })

  it('does not classify directory components with dots as images', () => {
    expect(isImageDropPath('/home/jane.png/photo')).toBe(false)
    expect(isImageDropPath('/home/jane.doe/screenshot')).toBe(false)
  })
})

describe('canPasteImageDropPathRaw', () => {
  it('pastes plain names raw', () => {
    expect(canPasteImageDropPathRaw('/tmp/orca-paste-1-abc.png', 'posix')).toBe(true)
    expect(canPasteImageDropPathRaw('C:\\Temp\\orca-paste-1-abc.png', 'windows')).toBe(true)
  })

  it('treats an ASCII space as unsafe but leaves U+202F alone', () => {
    expect(
      canPasteImageDropPathRaw('/t/Screenshot 2026-09-28 at 4.03.11\u202fPM.png', 'posix')
    ).toBe(false)
    expect(canPasteImageDropPathRaw('C:\\My Pictures\\shot.png', 'windows')).toBe(false)
    expect(canPasteImageDropPathRaw('/t/4.03.11\u202fPM.png', 'posix')).toBe(true)
  })
})

// Why: small replays of how agents recover a path from pasted text, so the
// escaped form is checked against what they actually accept.

// Claude Code 2.1.285 `S` then `x`: strip one pair of outer quotes, then
// unescape `\X` to `X` with `\\` kept as one backslash.
function claudeCodeRecoverPath(pasted: string): string {
  const unquoted = /^(['"]).*\1$/s.test(pasted) ? pasted.slice(1, -1) : pasted
  return unquoted.replace(/\\(.)/gs, '$1')
}

// Codex `normalize_pasted_path`: a drive/UNC path skips shlex once one outer
// quote pair is stripped; anything else must shlex-split into exactly one token.
function codexRecoverPath(pasted: string): string | null {
  const unquoted = pasted.replace(/^(['"])(.*)\1$/s, '$2')
  if (/^([a-z]:[\\/]|\\\\)/i.test(unquoted)) {
    return unquoted
  }
  const tokens: string[] = []
  let current: string | null = null
  let quote: "'" | '"' | null = null
  for (let i = 0; i < pasted.length; i += 1) {
    const char = pasted[i]
    if (quote === "'") {
      if (char === "'") {
        quote = null
      } else {
        current += char
      }
    } else if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && /["\\$`]/.test(pasted[i + 1] ?? '')) {
        current += pasted[++i]
      } else {
        current += char
      }
    } else if (char === ' ' || char === '\t' || char === '\n') {
      if (current !== null) {
        tokens.push(current)
        current = null
      }
    } else {
      current ??= ''
      if (char === '\\') {
        current += pasted[++i] ?? ''
      } else if (char === "'" || char === '"') {
        quote = char
      } else {
        current += char
      }
    }
  }
  if (quote !== null) {
    return null
  }
  if (current !== null) {
    tokens.push(current)
  }
  return tokens.length === 1 ? tokens[0] : null
}

describe('formatImageDropPasteText', () => {
  it('backslash-escapes unsafe POSIX characters and double-quotes on Windows', () => {
    expect(formatImageDropPasteText('/t/shot.png', 'posix')).toBe('/t/shot.png')
    expect(formatImageDropPasteText("/t/it's (1).png", 'posix')).toBe("/t/it\\'s\\ \\(1\\).png")
    expect(formatImageDropPasteText('C:\\My Pictures\\shot.png', 'windows')).toBe(
      '"C:\\My Pictures\\shot.png"'
    )
  })

  it('refuses paths a paste frame would alter', () => {
    expect(formatImageDropPasteText('/t/a\nb.png', 'posix')).toBeNull()
    expect(formatImageDropPasteText('/t/a\u001bb.png', 'posix')).toBeNull()
    expect(formatImageDropPasteText('C:\\t\\a\u0007b.png', 'windows')).toBeNull()
  })
})

// pi-image-paste 1.0.0 `tokenizePathLikeText` + `tryExtendBareToken`, bare tokens
// only (the escaped POSIX form never starts with a quote): a token keeps `\X`
// pairs, stops at any JS whitespace (U+202F included) and is shell-unescaped;
// if no file exists it extends across up to 8 following words.
function piImagePasteRecoverPath(pasted: string, exists: (path: string) => boolean): string | null {
  const unescape = (text: string): string => text.replace(/\\(.)/gs, '$1')
  let index = 0
  let raw = ''
  while (index < pasted.length && !/\s/.test(pasted[index])) {
    if (pasted[index] === '\\' && index + 1 < pasted.length) {
      raw += pasted.slice(index, index + 2)
      index += 2
    } else {
      raw += pasted[index++]
    }
  }
  let value = unescape(raw)
  for (let step = 0; step < 8 && !exists(value); step += 1) {
    let wordStart = index
    while (
      wordStart < pasted.length &&
      /\s/.test(pasted[wordStart]) &&
      pasted[wordStart] !== '\n'
    ) {
      wordStart += 1
    }
    let wordEnd = wordStart
    while (wordEnd < pasted.length && !/\s/.test(pasted[wordEnd])) {
      wordEnd += 1
    }
    if (wordStart === index || wordEnd === wordStart) {
      break
    }
    value += pasted.slice(index, wordStart) + unescape(pasted.slice(wordStart, wordEnd))
    index = wordEnd
  }
  return exists(value) ? value : null
}

describe('agent recovery of pasted image paths', () => {
  const screenshot = '/t/Screenshot 2026-09-28 at 4.03.11\u202fPM.png'

  it.each([
    screenshot,
    "/t/it's.png",
    '/t/download (1).png',
    '/t/a.png; touch /tmp/pwned #.png',
    '/t/"q" $HOME `x` \\ [1] {2} *?!&|<>~.png'
  ])('recovers %j in Claude Code, Codex and Pi', (path) => {
    const pasted = formatImageDropPasteText(path, 'posix') ?? ''
    expect(claudeCodeRecoverPath(pasted)).toBe(path)
    expect(codexRecoverPath(pasted)).toBe(path)
    expect(piImagePasteRecoverPath(pasted, (candidate) => candidate === path)).toBe(path)
  })

  it("shows why the quoted `'\\''` form was not used: Claude Code corrupts it", () => {
    expect(claudeCodeRecoverPath("'/t/it'\\''s.png'")).toBe("/t/it'''s.png")
  })

  it('recovers a double-quoted spaced Windows path in Codex', () => {
    const path = 'C:\\Users\\me\\My Pictures\\shot.png'
    expect(codexRecoverPath(formatImageDropPasteText(path, 'windows') ?? '')).toBe(path)
  })

  it('shows why a raw spaced path is not enough for Codex', () => {
    expect(codexRecoverPath(screenshot)).toBeNull()
  })
})
