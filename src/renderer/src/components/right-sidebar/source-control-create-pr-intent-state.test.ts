import { describe, expect, it } from 'vitest'
import { resolveVisibleCreatePrHeaderAction } from './source-control-create-pr-intent-state'
import type { PrimaryAction } from './source-control-primary-action-types'

const disabledCreatePrAction: PrimaryAction = {
  kind: 'create_pr',
  label: 'Create PR',
  title: 'Publish commits before creating a pull request.',
  disabled: true
}

const enabledCreatePrAction: PrimaryAction = {
  kind: 'create_pr',
  label: 'Create PR',
  title: 'Create a pull request for this branch',
  disabled: false
}

describe('resolveVisibleCreatePrHeaderAction', () => {
  it('returns null when no header action is available', () => {
    expect(
      resolveVisibleCreatePrHeaderAction({
        createPrHeaderAction: null
      })
    ).toBeNull()
  })

  it('keeps a disabled Create PR header visible as a stable toolbar anchor', () => {
    expect(
      resolveVisibleCreatePrHeaderAction({
        createPrHeaderAction: disabledCreatePrAction
      })
    ).toEqual(disabledCreatePrAction)
  })

  it('keeps an enabled Create PR header visible even when the body composer is open', () => {
    expect(
      resolveVisibleCreatePrHeaderAction({
        createPrHeaderAction: enabledCreatePrAction
      })
    ).toEqual(enabledCreatePrAction)
  })
})
