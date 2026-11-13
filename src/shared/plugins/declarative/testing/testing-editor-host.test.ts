import { afterEach, describe, expect, it } from 'vitest'
import { mockEditorHost, type MockEditorHost } from './testing-editor-host'
import type { MockEditorSession, MockEditorSessionOptions } from './testing-editor-frame-api'

/** `orca.document.session(options)` on the installed host, as an editor would call it. */
function session(options: MockEditorSessionOptions = {}): Promise<MockEditorSession> {
  if (!host) {
    throw new Error('no mockEditorHost')
  }
  return host.orca.document.session({ debounceMs: 0, ...options })
}

let host: MockEditorHost | null = null
afterEach(() => {
  host?.dispose()
  host = null
})

describe('mockEditorHost', () => {
  it('sends outside changes and refuses the next edit on conflictNext', async () => {
    host = mockEditorHost({ text: 'a' })
    const replaced: unknown[] = []
    const doc = await session({
      merge: (_base: string, outside: string, mine: string) => outside + mine
    })
    doc.onReplace((value) => replaced.push(value))
    host.replace('outside')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replaced).toEqual(['outside'])
    host.conflictNext('agent')
    doc.change('outside!')
    await doc.flush()
    expect(host.edits.map((edit) => edit.refused ?? 'applied')).toEqual(['conflict', 'applied'])
    expect(host.text).toBe('agentoutside!')
    expect(replaced.at(-1)).toBe('agentoutside!')
    doc.dispose()
  })
})
