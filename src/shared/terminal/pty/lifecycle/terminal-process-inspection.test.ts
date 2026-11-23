import { describe, expect, it } from 'vitest'
import { classifyTerminalProcessInspectionFailure } from './terminal-process-inspection'

describe('classifyTerminalProcessInspectionFailure', () => {
  it('keeps an unavailable-runtime failure as transport loss when contextual host text mentions terminal_gone', () => {
    const error = Object.assign(
      new Error("Could not connect to the remote Orca runtime. terminal_gone isn't answering."),
      { code: 'remote_runtime_unavailable' }
    )

    expect(classifyTerminalProcessInspectionFailure(error)).toBe('transport_loss')
  })
})
