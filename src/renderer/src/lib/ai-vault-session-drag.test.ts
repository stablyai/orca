import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_VAULT_SESSION_DRAG_TYPE,
  clearAiVaultSessionDragData,
  hasAiVaultSessionDragData,
  readAiVaultSessionDragData,
  writeAiVaultSessionDragData,
  type AiVaultSessionDragPayload
} from './ai-vault-session-drag'

class FakeDataTransfer {
  effectAllowed = 'all'
  types: string[] = []
  private readonly data = new Map<string, string>()

  setData(type: string, value: string): void {
    if (!this.types.includes(type)) {
      this.types.push(type)
    }
    this.data.set(type, value)
  }

  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
}

class TypeOnlyDataTransfer extends FakeDataTransfer {
  override getData(_type: string): string {
    return ''
  }
}

function createTransfer(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer
}

describe('Session History session drag data', () => {
  afterEach(() => {
    clearAiVaultSessionDragData()
  })

  it('writes and reads the private session history payload', () => {
    const transfer = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'claude',
      sessionId: 'session-1',
      title: 'Fix terminal split',
      command: "cd '/repo' && claude --resume session-1"
    }

    writeAiVaultSessionDragData(transfer, payload)

    expect(transfer.effectAllowed).toBe('copy')
    expect(hasAiVaultSessionDragData(transfer)).toBe(true)
    expect(readAiVaultSessionDragData(transfer)).toEqual(payload)
  })

  it('rejects malformed payloads', () => {
    const transfer = createTransfer()
    transfer.setData(
      AI_VAULT_SESSION_DRAG_TYPE,
      JSON.stringify({ kind: 'ai-vault-session', version: 1, agent: 'bad', command: 'claude' })
    )

    expect(readAiVaultSessionDragData(transfer)).toBeNull()
  })

  it('falls back to the active renderer drag payload when Chromium hides custom data', () => {
    const source = createTransfer()
    const payload: AiVaultSessionDragPayload = {
      agent: 'codex',
      sessionId: 'session-2',
      title: 'Resume a hidden payload',
      command: "cd '/repo' && codex resume session-2"
    }
    writeAiVaultSessionDragData(source, payload)

    const dropTransfer = new TypeOnlyDataTransfer() as unknown as DataTransfer
    dropTransfer.setData(AI_VAULT_SESSION_DRAG_TYPE, '')

    expect(hasAiVaultSessionDragData(dropTransfer)).toBe(true)
    expect(readAiVaultSessionDragData(dropTransfer)).toEqual(payload)

    clearAiVaultSessionDragData()
    expect(readAiVaultSessionDragData(dropTransfer)).toBeNull()
  })
})
