import { describe, expect, it } from 'vitest'
import { quotePowerShellLiteral, quotePowerShellNativeArgument } from './powershell-native-argument'

describe('PowerShell native argument quoting', () => {
  it('escapes literals for PowerShell source parsing', () => {
    expect(quotePowerShellLiteral("WSL 'Preview'")).toBe("'WSL ''Preview'''")
    expect(quotePowerShellLiteral('O\u2019Brien \u2018x\u201A\u201B')).toBe(
      "'O\u2019\u2019Brien \u2018\u2018x\u201A\u201A\u201B\u201B'"
    )
  })

  it('pre-escapes embedded quotes for Windows native argv parsing', () => {
    expect(quotePowerShellNativeArgument('eval "decoded"')).toBe(String.raw`'eval \"decoded\"'`)
    expect(quotePowerShellNativeArgument(String.raw`before\"after`)).toBe(
      String.raw`'before\\\"after'`
    )
  })
})
