import { describe, expect, it } from 'vitest'
import { formatProbeFailure } from './run.mjs'

describe('packaged Windows native smoke runner boundary', () => {
  it('keeps timeout evidence bounded and preserves both output channels', () => {
    const failure = formatProbeFailure({
      code: null,
      timedOut: true,
      stdout: `old-${'x'.repeat(9_000)}-stdout-tail`,
      stderr: 'stage=target-spawn:start'
    })

    expect(failure).toContain('code=null, timedOut=true')
    expect(failure).not.toContain('old-')
    expect(failure).toContain('stdout-tail')
    expect(failure).toContain('stage=target-spawn:start')
  })
})
