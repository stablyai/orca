import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { cloudRestartAttemptModel } from './cloud-running-strip-model'

const attempt = { agent: 'claude' as const, resumable: true, ptyId: 'p', launchedAt: null }

describe('RA-11 Restart feedback copy', () => {
  it('restarting: spinner, title, the button disabled, no dismiss', () => {
    const model = cloudRestartAttemptModel({ ...attempt, phase: 'restarting' }, translate)
    expect(model).toMatchObject({
      status: 'busy',
      title: 'Restarting Claude…',
      primary: { label: 'Restart Claude', action: { kind: 'restart' }, busy: true }
    })
    expect(model.dismiss).toBeUndefined()
  })

  it('failed: says so and offers Try again and a dismiss', () => {
    const model = cloudRestartAttemptModel({ ...attempt, phase: 'failed' }, translate)
    expect(model).toMatchObject({
      status: 'error',
      title: 'Couldn’t restart Claude',
      detail: 'Try again.',
      primary: { label: 'Try again', action: { kind: 'restart' } },
      dismiss: 'Dismiss',
      announcement: 'Couldn’t restart Claude. Try again.'
    })
    expect(model.primary?.busy).toBeUndefined()
  })
})
