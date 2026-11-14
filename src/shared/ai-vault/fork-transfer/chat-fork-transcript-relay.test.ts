import { describe, expect, it } from 'vitest'
import { relayChatForkTranscript, type ChatForkRelayCall } from './chat-fork-transcript-relay'

const EXPORT_ID = '11111111-1111-4111-8111-111111111111'
const IMPORT_ID = '22222222-2222-4222-8222-222222222222'
const SOURCE_SESSION = '33333333-3333-4333-8333-333333333333'
const PLACED_SESSION = '44444444-4444-4444-8444-444444444444'
const SHA = 'a'.repeat(64)
// Ten bytes moved four at a time: chunks "0123", "4567", "89".
const SOURCE_BYTES = '0123456789'

function hosts(options: { failAppendAt?: number } = {}) {
  const calls: string[] = []
  const received: string[] = []
  const sourceCall: ChatForkRelayCall = async (method, params) => {
    calls.push(`source ${method}`)
    if (method === 'aiVault.exportChatFork') {
      return {
        exportId: EXPORT_ID,
        agent: 'claude',
        byteLength: 10,
        sha256: SHA,
        sourceSessionId: SOURCE_SESSION,
        chunkBytes: 4
      }
    }
    if (method === 'aiVault.readChatForkExport') {
      const offset = Number(params.offset)
      const bytes = SOURCE_BYTES.slice(offset, offset + Number(params.length))
      return { bytesBase64: Buffer.from(bytes).toString('base64'), eof: offset + 4 >= 10 }
    }
    return { released: true }
  }
  const targetCall: ChatForkRelayCall = async (method, params) => {
    calls.push(`target ${method}`)
    if (method === 'aiVault.beginChatForkImport') {
      expect(params).toMatchObject({ byteLength: 10, sha256: SHA, worktree: 'id:wt-target' })
      return { importId: IMPORT_ID, chunkBytes: 8 }
    }
    if (method === 'aiVault.appendChatForkImport') {
      const chunk = Buffer.from(String(params.bytesBase64), 'base64').toString()
      if (received.join('').length === options.failAppendAt) {
        throw new Error('disk full')
      }
      received.push(chunk)
      return { acknowledgedOffset: Number(params.offset) + chunk.length }
    }
    if (method === 'aiVault.commitChatForkImport') {
      return {
        agent: 'claude',
        sessionId: PLACED_SESSION,
        filePath: '/target/.claude/projects/-work-target/x.jsonl',
        cwd: '/work/target',
        worktreeId: 'wt-target',
        resumeCursor: 'cursor-1'
      }
    }
    return { cancelled: true }
  }
  return { calls, received, sourceCall, targetCall }
}

describe('relayChatForkTranscript', () => {
  it('moves every chunk in order with the source’s hash, then releases the export', async () => {
    const { calls, received, sourceCall, targetCall } = hosts()
    const progress: number[] = []
    const result = await relayChatForkTranscript({
      source: { terminal: { sessionId: SOURCE_SESSION, throughEntryId: 'entry-1' } },
      targetWorktree: 'id:wt-target',
      sourceCall,
      targetCall,
      onProgress: (done) => progress.push(done)
    })
    expect(received).toEqual(['0123', '4567', '89'])
    expect(progress).toEqual([0, 4, 8, 10])
    expect(result.importId).toBe(IMPORT_ID)
    expect(result.placed.sessionId).toBe(PLACED_SESSION)
    expect(calls.at(-1)).toBe('source aiVault.releaseChatForkExport')
    expect(calls).not.toContain('target aiVault.cancelChatForkImport')
  })

  it('cancels the import and releases the export when an append fails', async () => {
    const { calls, sourceCall, targetCall } = hosts({ failAppendAt: 4 })
    await expect(
      relayChatForkTranscript({
        source: { terminal: { sessionId: SOURCE_SESSION, throughEntryId: 'entry-1' } },
        targetWorktree: 'id:wt-target',
        sourceCall,
        targetCall
      })
    ).rejects.toThrow('disk full')
    expect(calls).toContain('source aiVault.releaseChatForkExport')
    expect(calls).toContain('target aiVault.cancelChatForkImport')
    expect(calls).not.toContain('target aiVault.commitChatForkImport')
  })
})
