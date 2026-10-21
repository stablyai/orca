import { describe, expect, it } from 'vitest'
import { quotePowerShellLiteral, quotePowerShellNativeArgument } from './powershell-native-argument'

describe('PowerShell native argument quoting', () => {
  it('escapes literals for PowerShell source parsing', () => {
    expect(quotePowerShellLiteral("WSL 'Preview'")).toBe("'WSL ''Preview'''")
    expect(quotePowerShellLiteral('O\u2019Brien \u2018x\u201A\u201B')).toBe(
      "'O\u2019\u2019Brien \u2018\u2018x\u201A\u201A\u201B\u201B'"
    )
  })

  it('keeps a value with a line break on one physical line', () => {
    expect(quotePowerShellLiteral('line one\nline two')).toBe('"line one`nline two"')
    expect(quotePowerShellLiteral('a\r\nb\rc')).toBe('"a`r`nb`rc"')
  })

  it('escapes the double-quoted specials in a multi-line value', () => {
    expect(
      quotePowerShellLiteral('$(Remove-Item x) `t "q" \u201Cl\u201D \u201Elow \'single\'\nend')
    ).toBe('"`$(Remove-Item x) ``t `"q`" `\u201Cl`\u201D `\u201Elow \'single\'`nend"')
  })

  it('leaves single-line values on the single-quoted form', () => {
    expect(quotePowerShellLiteral('a $b `c "d"')).toBe('\'a $b `c "d"\'')
  })

  it('pre-escapes embedded quotes for Windows native argv parsing', () => {
    expect(quotePowerShellNativeArgument('eval "decoded"')).toBe(String.raw`'eval \"decoded\"'`)
    expect(quotePowerShellNativeArgument(String.raw`before\"after`)).toBe(
      String.raw`'before\\\"after'`
    )
    // Why: the argv pre-escape survives the multi-line form, so 5.1 still passes `\"` to argv.
    expect(quotePowerShellNativeArgument('say "hi"\nbye')).toBe('"say \\`"hi\\`"`nbye"')
  })
})
