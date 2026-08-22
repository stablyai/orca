import { describe, expect, it } from 'vitest'
import { blankStringContents, stripComments } from './source-tree-scan'

/**
 * These guards are only worth having if they cannot under-report.
 *
 * The first version of `stripComments` read the slash-star inside a POSIX glob
 * as a comment opener and blanked 24,000 characters of live code, so the
 * windowsHide guard walked past a real unguarded spawn and called the file
 * clean. Every case here is a shape that produced, or would produce, that.
 */
describe('stripComments', () => {
  it('leaves a POSIX glob in a template literal alone', () => {
    const source = ['const s = `', '  case "$root"/*/home) echo hit;; esac', '`', 'spawn(x)'].join(
      '\n'
    )
    expect(stripComments(source)).toContain('case "$root"/*/home)')
    expect(stripComments(source)).toContain('spawn(x)')
  })

  it('still removes a real block comment', () => {
    expect(stripComments('/* spawn(bad) */ spawn(good)')).not.toContain('bad')
    expect(stripComments('/* spawn(bad) */ spawn(good)')).toContain('good')
  })

  it('keeps line count stable so reported lines stay honest', () => {
    const source = '/*\n\n*/\nspawn(x)'
    expect(stripComments(source).split('\n')).toHaveLength(source.split('\n').length)
  })

  it('is not derailed by an apostrophe in prose', () => {
    // An unterminated quote used to swallow the rest of the file, so every
    // later comment stopped being stripped.
    const source = ["// don't do this", '/* spawn(bad) */', 'spawn(good)'].join('\n')
    expect(stripComments(source)).not.toContain('bad')
  })

  it('is not derailed by a quote inside a regex literal', () => {
    const source = ["const re = /['\"]/", '/* spawn(bad) */', 'spawn(good)'].join('\n')
    expect(stripComments(source)).not.toContain('bad')
  })

  it('handles an escaped quote inside a string', () => {
    const source = ['const s = \'it\\\'s\'', '/* spawn(bad) */'].join('\n')
    expect(stripComments(source)).not.toContain('bad')
  })
})

describe('blankStringContents', () => {
  it('neutralises parentheses inside a string so a call is matched whole', () => {
    // A shell script embedded as a string closed the call early, so the options
    // object fell outside the match and its flags read as absent.
    const source = `execFileSync('wsl.exe', ['-c', 'test "$(cat x)" = y'], { windowsHide: true })`
    const blanked = blankStringContents(source)
    let depth = 0
    let end = 0
    for (let i = blanked.indexOf('('); i < blanked.length; i += 1) {
      if (blanked[i] === '(') {
        depth += 1
      } else if (blanked[i] === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    expect(blanked.slice(0, end)).toContain('windowsHide')
  })

  it('keeps the quotes themselves, so an import can still be recognised', () => {
    expect(blankStringContents(`from 'node:child_process'`)).toContain("'")
  })

  it('preserves newlines', () => {
    const source = 'const a = `x\ny`\n'
    expect(blankStringContents(source).split('\n')).toHaveLength(source.split('\n').length)
  })
})
