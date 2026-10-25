import { describe, expect, it } from 'vitest'
import { TERMINAL_RENDER_DESYNC_CAPTURE_ID_PATTERN } from '../../../../shared/terminal-render-desync-evidence'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { createCaptureId } from './terminal-render-desync-evidence-persistence'

describe('createCaptureId', () => {
  // A real paneKey is two UUIDs joined by ':'. Unbounded, the id ran 124 chars and main
  // rejected every capture with 'Invalid render-desync capture id'.
  it('stays inside the id main will accept for a realistic paneKey', () => {
    const paneKey = makePaneKey(createBrowserUuid(), createBrowserUuid())

    expect(createCaptureId(paneKey)).toMatch(TERMINAL_RENDER_DESYNC_CAPTURE_ID_PATTERN)
  })

  it('keeps the leaf id so a capture is still traceable to its pane', () => {
    const leafId = createBrowserUuid()

    expect(createCaptureId(makePaneKey(createBrowserUuid(), leafId))).toContain(leafId)
  })

  it('does not collide for repeated captures of the same pane', () => {
    const paneKey = makePaneKey(createBrowserUuid(), createBrowserUuid())

    expect(createCaptureId(paneKey)).not.toBe(createCaptureId(paneKey))
  })
})
