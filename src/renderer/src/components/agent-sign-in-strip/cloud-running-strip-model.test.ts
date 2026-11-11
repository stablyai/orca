import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { cloudRestartAttemptModel } from './cloud-running-strip-model'

const attempt = { agent: 'claude' as const, resumable: true, ptyId: 'p', launchedAt: null }

describe('RA-11 Restart feedback copy', () => {
  it('restarting: spinner and words only, no button and nothing to close', () => {
    const model = cloudRestartAttemptModel({ ...attempt, phase: 'restarting' }, translate)
    expect(model).toMatchObject({
      status: 'busy',
      title: 'Restarting Claude…',
      detail: 'Picking up where you left off.',
      primary: null,
      noClose: true
    })
    expect(model.dismiss).toBeUndefined()
    const fresh = cloudRestartAttemptModel(
      { ...attempt, resumable: false, phase: 'restarting' },
      translate
    )
    expect(fresh.detail).toBe('Starts a new conversation.')
  })

  it('failed: says so once, the reason when known, and offers Try again and a dismiss', () => {
    const unresponsive = cloudRestartAttemptModel(
      { ...attempt, phase: 'failed', failure: 'hostUnresponsive' },
      translate
    )
    expect(unresponsive.detail).toBe('The workspace didn’t respond.')
    const model = cloudRestartAttemptModel({ ...attempt, phase: 'failed' }, translate)
    expect(model).toMatchObject({
      status: 'error',
      title: 'Couldn’t restart Claude',
      detail: '',
      primary: { label: 'Try again', action: { kind: 'restart' } },
      dismiss: 'Dismiss',
      announcement: 'Couldn’t restart Claude. Try again.'
    })
    expect(model.primary?.busy).toBeUndefined()
  })
})
