import { describe, expect, it, vi } from 'vitest'
import { createAutomationShellReceiptScanner } from './automation-shell-exit-receipt'

const receipt = '\x1b]133;D;7;orca-automation:run-1\x07'

describe('automation command exit receipt', () => {
  it('recognizes a receipt across every possible chunk boundary', () => {
    for (let split = 0; split <= receipt.length; split++) {
      const onExit = vi.fn()
      const scanner = createAutomationShellReceiptScanner('run-1', onExit)
      scanner.scan(receipt.slice(0, split))
      scanner.scan(receipt.slice(split))
      expect(onExit.mock.calls).toEqual([[7]])
    }
  })

  it('ignores ordinary shell markers, other runs, and malformed exit codes', () => {
    const onExit = vi.fn()
    const scanner = createAutomationShellReceiptScanner('run-1', onExit)
    scanner.scan('\x1b]133;D;0\x07')
    scanner.scan('\x1b]133;D;0;orca-automation:run-2\x07')
    for (const code of ['', '0garbage', '1.5', 'Infinity', '9007199254740993']) {
      scanner.scan(`\x1b]133;D;${code};orca-automation:run-1\x07`)
    }
    expect(onExit).not.toHaveBeenCalled()
    scanner.scan('\x1b]133;D;-1;orca-automation:run-1\x1b\\')
    expect(onExit.mock.calls).toEqual([[-1]])
  })

  it('drops incomplete receipts on reset and recovers after oversized input', () => {
    const onExit = vi.fn()
    const scanner = createAutomationShellReceiptScanner('run-1', onExit)
    scanner.scan(receipt.slice(0, -1))
    scanner.reset()
    scanner.scan('\x07')
    scanner.scan(`\x1b]133;${'x'.repeat(5000)}`)
    scanner.scan(receipt)
    expect(onExit.mock.calls).toEqual([[7]])
  })
})
