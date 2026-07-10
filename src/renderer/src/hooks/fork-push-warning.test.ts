import { describe, expect, it } from 'vitest'
import { FORK_PUSH_NO_MAINTAINER_EDIT_WARNING, getForkPushWarning } from './fork-push-warning'

const forkTarget = { remoteName: 'pr-contributor-orca', branchName: 'contributor/fix' }
const originTarget = { remoteName: 'origin', branchName: 'feature/fix' }

describe('getForkPushWarning', () => {
  it('warns for a fork PR whose author disabled maintainer edits', () => {
    expect(getForkPushWarning({ pushTarget: forkTarget, maintainerCanModify: false })).toBe(
      FORK_PUSH_NO_MAINTAINER_EDIT_WARNING
    )
  })

  it('does not warn when maintainer edits are allowed', () => {
    expect(getForkPushWarning({ pushTarget: forkTarget, maintainerCanModify: true })).toBeNull()
  })

  it('does not warn when the maintainer flag is unknown', () => {
    expect(getForkPushWarning({ pushTarget: forkTarget })).toBeNull()
  })

  it('does not warn for a same-repo PR even if the flag is false (we own origin)', () => {
    expect(getForkPushWarning({ pushTarget: originTarget, maintainerCanModify: false })).toBeNull()
  })

  it('does not warn when there is no resolved push target', () => {
    expect(getForkPushWarning({ maintainerCanModify: false })).toBeNull()
  })
})
