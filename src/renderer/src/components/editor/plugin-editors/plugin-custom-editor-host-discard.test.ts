import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPanelMessageBudget } from '../../../../../shared/plugins/frames/plugin-panel-message-budget'
import { createCustomEditorHost } from './plugin-custom-editor-host'

describe('createCustomEditorHost discardPending', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops a rate-limited held edit instead of applying it into the buffer', () => {
    vi.useFakeTimers()
    const edits: string[] = []
    const frameWindow = { postMessage: () => {} }
    const host = createCustomEditorHost({
      getFrameWindow: () => frameWindow,
      getDocument: () => ({ text: '', readOnly: false }),
      onEdit: (text) => edits.push(text),
      budget: createPanelMessageBudget({ maxMessages: 1, perMs: 10_000 })
    })
    host.channel.onReady()
    const edit = (text: string, id: number) => ({
      orca: 1,
      kind: 'req',
      id,
      method: 'editor.applyEdit',
      params: { baseVersion: 1, content: { kind: 'text', text } }
    })
    host.channel.claim(edit('first', 1))
    host.channel.claim(edit('second', 2))
    expect(edits).toEqual(['first'])

    host.discardPending()
    vi.advanceTimersByTime(10_000)
    expect(edits).toEqual(['first'])
  })
})
