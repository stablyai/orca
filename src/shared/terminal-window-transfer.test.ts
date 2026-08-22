import { describe, expect, it } from 'vitest'
import type {
  TerminalWindowTransferCommand,
  TerminalWindowTransferSeed
} from './terminal-window-transfer'

const seed = {} as TerminalWindowTransferSeed
const importCommand: TerminalWindowTransferCommand = {
  transferId: 'transfer-1',
  tabId: 'tab-1',
  phase: 'target-import',
  seed
}
const removeCommand: TerminalWindowTransferCommand = {
  transferId: 'transfer-1',
  tabId: 'tab-1',
  phase: 'target-remove'
}

// @ts-expect-error seeded phases require a seed
const missingSeed: TerminalWindowTransferCommand = {
  transferId: 'transfer-1',
  tabId: 'tab-1',
  phase: 'source-restore'
}

// @ts-expect-error remove phases reject a seed
const unexpectedSeed: TerminalWindowTransferCommand = {
  transferId: 'transfer-1',
  tabId: 'tab-1',
  phase: 'source-remove',
  seed
}

describe('terminal window transfer command contract', () => {
  it('requires seeds only for import and restore commands', () => {
    expect([importCommand.phase, removeCommand.phase]).toEqual(['target-import', 'target-remove'])
    expect([missingSeed.phase, unexpectedSeed.phase]).toEqual(['source-restore', 'source-remove'])
  })
})
