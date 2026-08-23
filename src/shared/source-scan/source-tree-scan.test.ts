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
    const source = ['const re = /[\'"]/', '/* spawn(bad) */', 'spawn(good)'].join('\n')
    expect(stripComments(source)).not.toContain('bad')
  })

  it('handles an escaped quote inside a string', () => {
    const source = ["const s = 'it\\'s'", '/* spawn(bad) */'].join('\n')
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

describe('regex literals', () => {
  it('does not let an apostrophe in a pattern open a string', () => {
    // The real shape, from a shell quoter: the `'` inside /'/g read as a string
    // opener and desynced every later line, so a scan of the file silently
    // found nothing and its guard reported clean.
    const source =
      "const q = (v: string): string => `'${v.replace(/'/g, \"x\")}'`\nspawn('wsl.exe')\n"
    expect(blankStringContents(source, true)).not.toBe('desynced')
    expect(blankStringContents(source)).toContain('spawn(')
  })

  it('treats a leading block comment as a comment, not a pattern', () => {
    // `/*` at index 0 has no preceding token, so the prev-token test called it
    // a pattern and swallowed to the next `/` -- 110k characters of a real
    // file, in the direction that hides offenders.
    const source = '/* banner with a renderer/Electron slash */\nspawn("wsl.exe")\n'
    // Assert the swallowed span itself survives: `spawn(` sits after the bad
    // region, so checking only for it passes even while the banner is eaten.
    expect(blankStringContents(source)).toContain('banner with a renderer')
  })

  it.each([
    [
      'postfix decrement',
      "const half = n-- / 2; execFile(bin, args, { cwd: '/usr/bin' })",
      'execFile(bin, args'
    ],
    ['non-null assertion', 'const b = done! / total!\nexecFile(y)\n', 'execFile(y)'],
    [
      'JSX self-close',
      'const a = c ? <A size={14} /> : <B size={14} />\nexecFile(x)\n',
      'execFile(x)'
    ]
  ])('reads %s as division, not a pattern', (_case, source, survives) => {
    // Blanking live code is the dangerous direction: the swallowed span took a
    // whole execFile call with it and left no desync behind, so the guard saw
    // zero calls and called the file clean.
    expect(blankStringContents(source)).toContain(survives)
  })

  it('still reads division as division', () => {
    const source = 'const a = (x) / 2\nconst b = arr[i] / 2\nspawn("wsl.exe")\n'
    expect(blankStringContents(source)).toContain('spawn(')
    expect(blankStringContents(source, true)).not.toBe('desynced')
  })
})
