import { describe, expect, it } from 'vitest'
import {
  EMPTY_FORM,
  applyParsedSshHostInput,
  getSshTargetDraftConnectionFields
} from './ssh-target-draft'

describe('applyParsedSshHostInput', () => {
  it('dials the edited Host after an earlier blur', () => {
    const blurred = applyParsedSshHostInput({ ...EMPTY_FORM, host: 'host-a.example' })
    const corrected = applyParsedSshHostInput({ ...blurred, host: 'host-b.example' })

    expect(getSshTargetDraftConnectionFields(corrected).configHost).toBe('host-b.example')
  })
})
