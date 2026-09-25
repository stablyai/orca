import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree, stripComments } from '../../../shared/source-scan/source-tree-scan'

const DERIVED_TAB_ID = /\bstructuredAgentSessionTabId\b/

function filesNaming(root: string): string[] {
  return scanSourceTree(root)
    .filter(({ source }) => DERIVED_TAB_ID.test(stripComments(source)))
    .map(({ relativePath }) => relativePath)
}

describe('renderer chat tab identity', () => {
  it('never derives a chat tab id from its session id in shipped renderer source', () => {
    expect(
      filesNaming(resolve(__dirname, '..', '..')),
      'A chat tab owns its id; find the tab for a session by contentType + entityId instead.'
    ).toEqual([])
  })

  it('sees the derivation where it is still defined, so an empty result is real', () => {
    expect(filesNaming(resolve(__dirname, '..', '..', '..', 'shared'))).toContain(
      'structured-agent-session-projection.ts'
    )
  })
})
