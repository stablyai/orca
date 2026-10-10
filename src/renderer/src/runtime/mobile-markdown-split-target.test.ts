import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { attachMobileMarkdownBridge } from './mobile-markdown-bridge'
import {
  cleanupMobileMarkdownBridgeHarness,
  openMarkdownFile,
  resetEditorState,
  sendRequest,
  setupWindow
} from './mobile-markdown-bridge-test-harness'

vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))

describe('mobile Markdown target boundaries', () => {
  beforeEach(resetEditorState)
  afterEach(cleanupMobileMarkdownBridgeHarness)

  it.each(['read', 'save'] as const)(
    'does not %s a unified tab from another workspace',
    async (operation) => {
      openMarkdownFile()
      const readFile = vi.fn()
      const writeFile = vi.fn()
      setupWindow({ readFile, writeFile })
      const detach = attachMobileMarkdownBridge()
      try {
        const response = await sendRequest(
          operation === 'read'
            ? { id: 'wrong-workspace', operation, worktreeId: 'wt-other', tabId: 'tab-md' }
            : {
                id: 'wrong-workspace',
                operation,
                worktreeId: 'wt-other',
                tabId: 'tab-md',
                baseVersion: 'old',
                content: 'replacement'
              }
        )
        expect(response).toMatchObject({ ok: false, error: 'tab_not_found' })
        expect(readFile).not.toHaveBeenCalled()
        expect(writeFile).not.toHaveBeenCalled()
      } finally {
        detach()
      }
    }
  )

  it('does not resolve a terminal wrapper to an editor entity', async () => {
    openMarkdownFile()
    useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
      id: 'terminal-wrapper',
      entityId: '/repo/README.md',
      recordInteraction: false
    })
    const readFile = vi.fn()
    setupWindow({ readFile })
    const detach = attachMobileMarkdownBridge()
    try {
      const response = await sendRequest({
        id: 'wrong-type',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'terminal-wrapper'
      })
      expect(response).toMatchObject({ ok: false, error: 'tab_not_found' })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('does not read a non-Markdown editor through its unified tab', async () => {
    openMarkdownFile()
    useAppStore.setState((state) => ({
      openFiles: state.openFiles.map((file) => ({ ...file, language: 'plaintext' }))
    }))
    const readFile = vi.fn()
    setupWindow({ readFile })
    const detach = attachMobileMarkdownBridge()
    try {
      const response = await sendRequest({
        id: 'wrong-language',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })
      expect(response).toMatchObject({ ok: false, error: 'tab_not_found' })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })
})
