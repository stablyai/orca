import { describe, expect, it } from 'vitest'
import { blankStringContents, stripComments } from './source-tree-scan'

/** A glob’s slash-star once hid 24,000 live-code characters and an unguarded spawn; guards must never under-report. */
describe('stripComments', () => {
  it('leaves a POSIX glob in a template literal alone', () => {
    const source = ['const s = `', '  case "$root"/*/home) echo hit;; esac', '`', 'spawn(x)'].join(
      '\n'
    )
    expect(stripComments(source)).toContain('case "$root"/*/home)')
    expect(stripComments(source)).toContain('spawn(x)')
  })

  it('is not derailed by an apostrophe in prose', () => {
    // A prose apostrophe once swallowed the rest of the file and disabled later comment stripping.
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

describe('regex literals', () => {
  it('does not let an apostrophe in a pattern open a string', () => {
    // A regex apostrophe once inverted quote state for the rest of the file and hid real calls.
    const source =
      "const q = (v: string): string => `'${v.replace(/'/g, \"x\")}'`\nspawn('wsl.exe')\n"
    expect(blankStringContents(source, true)).not.toBe('desynced')
    expect(blankStringContents(source)).toContain('spawn(')
  })

  it('treats a leading block comment as a comment, not a pattern', () => {
    // A leading comment once read as a regex and swallowed 110k real-file characters.
    const source = '/* banner with a renderer/Electron slash */\nspawn("wsl.exe")\n'
    // Assert inside the swallowed span; checking only the following spawn misses the regression.
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
    // False regex positives swallow live calls without desync, making the guard report a false clean.
    expect(blankStringContents(source)).toContain(survives)
  })
})
