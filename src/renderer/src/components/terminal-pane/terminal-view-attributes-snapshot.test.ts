import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalViewAttributesPush } from '../../../../shared/terminal-view-attributes'
import {
  _resetTerminalViewAttributesSnapshotForTest,
  buildTerminalViewAttributesSnapshot,
  publishTerminalViewAttributesSnapshot
} from './terminal-view-attributes-snapshot'

beforeEach(() => {
  _resetTerminalViewAttributesSnapshotForTest()
})

describe('buildTerminalViewAttributesSnapshot', () => {
  it('includes only agents with persisted overrides', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: { codex: { dark: 'Dracula' } }
    }
    const snapshot = buildTerminalViewAttributesSnapshot(settings, true)
    expect(snapshot.kind).toBe('snapshot')
    expect(snapshot.byAgent.codex).toBeDefined()
    expect(snapshot.byAgent.claude).toBeUndefined()
    expect(snapshot.global.background).not.toEqual(snapshot.byAgent.codex?.background)
  })
})

describe('publishTerminalViewAttributesSnapshot dedupe', () => {
  it('publishes the full snapshot once and no-ops an identical reload', () => {
    const send = vi.fn<(push: TerminalViewAttributesPush) => boolean>(() => true)
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: { codex: { dark: 'Dracula' } }
    }
    expect(publishTerminalViewAttributesSnapshot(settings, true, send)).toBe(true)
    expect(publishTerminalViewAttributesSnapshot(settings, true, send)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].kind).toBe('snapshot')
    expect(send.mock.calls[0][0].byAgent.codex).toBeDefined()
  })

  it('republishes when only the Codex override changes', () => {
    const send = vi.fn<(push: TerminalViewAttributesPush) => boolean>(() => true)
    const settings = getDefaultSettings('/tmp')
    publishTerminalViewAttributesSnapshot(settings, true, send)
    publishTerminalViewAttributesSnapshot(
      { ...settings, agentTerminalThemes: { codex: { dark: 'Dracula' } } },
      true,
      send
    )
    expect(send).toHaveBeenCalledTimes(2)
  })
})
