import { describe, expect, it } from 'vitest'
import { resolveForegroundProcess } from './foreground-process-resolution'

describe('resolveForegroundProcess (old-relay string degradation)', () => {
  it('recognizes a known agent binary as the engine', () => {
    expect(resolveForegroundProcess('codex')).toEqual({
      engine: 'codex',
      rawProcessName: 'codex',
      isShell: false
    })
  })

  it('keeps an unrecognized non-shell process as a raw name with no engine', () => {
    // Why: a renamed/fork agent is the unknown-live case — carry the raw name so
    // the renderer can show a neutral live identity instead of a bare shell.
    expect(resolveForegroundProcess('my-fork')).toEqual({
      engine: null,
      rawProcessName: 'my-fork',
      isShell: false
    })
  })

  it('flags a shell process so the consumer never treats it as unknown-live', () => {
    expect(resolveForegroundProcess('zsh')).toEqual({
      engine: null,
      rawProcessName: 'zsh',
      isShell: true
    })
  })

  it('degrades an unavailable (null) read to an all-empty resolution', () => {
    expect(resolveForegroundProcess(null)).toEqual({
      engine: null,
      rawProcessName: null,
      isShell: false
    })
  })
})
