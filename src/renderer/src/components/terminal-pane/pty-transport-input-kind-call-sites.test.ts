import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSourceTree } from '../../../../shared/source-scan/source-tree-scan'
import {
  findCallsMissingArgument,
  type RequiredCallArgument
} from '../../../../shared/source-scan/call-argument-scan'

/**
 * Every renderer PTY write names its input kind. The pane-connection session is an `any` bag, so
 * `session.transport.sendInput(data)` compiles without one; this scan is the ratchet there.
 */
const RENDERER_ROOT = resolve(__dirname, '../..')
const TRANSPORT = /[Tt]ransport\??\s*$/
const KIND_ARGUMENT_BY_METHOD: Record<string, RequiredCallArgument> = {
  sendInput: { index: 1, receiver: TRANSPORT },
  sendInputAccepted: { index: 1, receiver: TRANSPORT }
}

describe('renderer PTY transport writes', () => {
  it('finds a transport write that leaves out its kind', () => {
    const planted = [
      '',
      'session.transport.sendInput(command)',
      "session.transport\n  .sendInputAccepted(data, 'driving')",
      'stream.sendInput(text)'
    ].join('\n')

    expect(findCallsMissingArgument(planted, KIND_ARGUMENT_BY_METHOD)).toEqual([
      '2: .sendInput(command)'
    ])
  })

  it('passes an input kind at every transport write', () => {
    const missing = scanSourceTree(RENDERER_ROOT).flatMap((file) =>
      findCallsMissingArgument(file.source, KIND_ARGUMENT_BY_METHOD).map(
        (site) => `${file.relativePath}:${site}`
      )
    )

    expect(missing).toEqual([])
  })
})
