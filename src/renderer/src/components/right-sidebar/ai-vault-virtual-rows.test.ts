// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  estimateVaultRowSize,
  extractVaultVirtualRowIndexes,
  getVaultRowKey,
  getVaultStickyHeaderIndexes,
  isCurrentVaultVirtualRowElement,
  VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT,
  VAULT_GROUP_HEADER_ROW_HEIGHT,
  VAULT_SESSION_ROW_HEIGHT,
  type AiVaultListRow
} from './ai-vault-virtual-rows'

const sampleSession: AiVaultSession = {
  id: 'local:codex:s1:/path/s1.jsonl',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 's1',
  title: 'Test Session',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/path/s1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-09-20T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 100,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume s1',
  subagent: null
}

const groupRow: AiVaultListRow = {
  type: 'group',
  group: { key: 'folder:/repo', label: 'repo', sessions: [sampleSession] }
}

const sessionRow: AiVaultListRow = {
  type: 'session',
  groupKey: 'folder:/repo',
  session: sampleSession
}

describe('ai-vault-virtual-rows', () => {
  it('derives stable row keys for group and session rows', () => {
    expect(getVaultRowKey(groupRow)).toBe('group:folder:/repo')
    expect(getVaultRowKey(sessionRow)).toBe('session:local:codex:s1:/path/s1.jsonl')
  })

  it('estimates row sizes for headers, sessions, and expanded sessions', () => {
    expect(estimateVaultRowSize(groupRow)).toBe(VAULT_GROUP_HEADER_ROW_HEIGHT)
    expect(estimateVaultRowSize(sessionRow)).toBe(VAULT_SESSION_ROW_HEIGHT)
    expect(estimateVaultRowSize(sessionRow, new Set([sampleSession.id]))).toBe(
      VAULT_EXPANDED_SESSION_ROW_ESTIMATED_HEIGHT
    )
    expect(estimateVaultRowSize(undefined)).toBe(VAULT_SESSION_ROW_HEIGHT)
  })

  it('identifies sticky header indexes', () => {
    const rows = [groupRow, sessionRow, groupRow, sessionRow]
    expect(getVaultStickyHeaderIndexes(rows)).toEqual([0, 2])
  })

  it('extracts virtual row indexes preserving sticky header', () => {
    const stickyHeaderIndexes = [0, 10]
    const extracted = extractVaultVirtualRowIndexes({
      range: { startIndex: 5, endIndex: 8, overscan: 0, count: 15 },
      stickyHeaderIndexes
    })
    expect(extracted).toContain(0)
    expect(extracted).toEqual([0, 5, 6, 7, 8])
  })

  describe('isCurrentVaultVirtualRowElement', () => {
    it('returns false when element is disconnected or missing index/key', () => {
      const rows = [groupRow, sessionRow]
      const el = document.createElement('div')
      expect(isCurrentVaultVirtualRowElement(el, rows)).toBe(false)

      document.body.appendChild(el)
      expect(isCurrentVaultVirtualRowElement(el, rows)).toBe(false)

      el.setAttribute('data-index', '0')
      expect(isCurrentVaultVirtualRowElement(el, rows)).toBe(false)

      el.setAttribute('data-vault-virtual-row-key', 'mismatched-key')
      expect(isCurrentVaultVirtualRowElement(el, rows)).toBe(false)

      document.body.removeChild(el)
    })

    it('returns true when element is connected and key matches vaultRows at index', () => {
      const rows = [groupRow, sessionRow]
      const el = document.createElement('div')
      document.body.appendChild(el)

      el.setAttribute('data-index', '1')
      el.setAttribute('data-vault-virtual-row-key', getVaultRowKey(sessionRow))
      expect(isCurrentVaultVirtualRowElement(el, rows)).toBe(true)

      // Out of bounds index
      el.setAttribute('data-index', '5')
      expect(isCurrentVaultVirtualRowElement(el, rows)).toBe(false)

      document.body.removeChild(el)
    })
  })
})
