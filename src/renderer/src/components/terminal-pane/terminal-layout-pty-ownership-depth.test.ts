import { expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'
import { normalizeTerminalLayoutPtyOwnership } from './terminal-layout-pty-ownership'

it('prunes deeply nested duplicate ownership without recursive stack growth', () => {
  const leafCount = 12_000
  let root: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-0' }
  const ptyIdsByLeafId: Record<string, string> = { 'leaf-0': 'pty-agent' }
  for (let index = 1; index < leafCount; index += 1) {
    const leafId = `leaf-${index}`
    root = {
      type: 'split',
      direction: 'vertical',
      first: root,
      second: { type: 'leaf', leafId }
    }
    ptyIdsByLeafId[leafId] = 'pty-agent'
  }

  const retainedLeafId = `leaf-${leafCount - 1}`
  const normalized = normalizeTerminalLayoutPtyOwnership({
    root,
    activeLeafId: retainedLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId
  }).snapshot

  expect(normalized.root).toEqual({ type: 'leaf', leafId: retainedLeafId })
  expect(normalized.ptyIdsByLeafId).toEqual({ [retainedLeafId]: 'pty-agent' })
})
