import { describe, expect, it } from 'vitest'
import { createHookListenerState, normalizeHookPayload } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const PANE_REF = '/private/tmp/tmux-501/default:%3'

function normalize(record: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(
    createHookListenerState(),
    'opencode',
    { paneKey: PANE_KEY, payload: { hook_event_name: 'SessionBusy' }, ...record },
    'production'
  )
}

// Why: the generated agent plugins send this field name verbatim, so a rename on
// either side would silently collapse sibling tmux panes back onto one status.
describe('hook payload tmuxPaneRef', () => {
  it('normalizes a busy event so the pane-ref assertions below are meaningful', () => {
    expect(normalize({})?.payload.state).toBe('working')
  })

  it('carries the reported pane ref through normalization', () => {
    expect(normalize({ tmuxPaneRef: PANE_REF })?.tmuxPaneRef).toBe(PANE_REF)
  })

  it('omits the pane ref when the agent runs outside tmux', () => {
    expect(normalize({ tmuxPaneRef: '' })?.tmuxPaneRef).toBeUndefined()
  })

  it('omits the pane ref when the field is absent', () => {
    expect(normalize({})?.tmuxPaneRef).toBeUndefined()
  })

  it('ignores a non-string pane ref', () => {
    expect(normalize({ tmuxPaneRef: 42 })?.tmuxPaneRef).toBeUndefined()
  })
})
