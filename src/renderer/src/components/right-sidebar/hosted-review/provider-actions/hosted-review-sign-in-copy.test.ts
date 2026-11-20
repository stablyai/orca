import { describe, expect, it } from 'vitest'
import { authRequiredDetail, hostedReviewSignInHint } from './hosted-review-sign-in-copy'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'

describe('Gitea sign-in copy', () => {
  it('mentions gt auth login alongside ORCA_GITEA_TOKEN in the auth-required detail', () => {
    const detail = authRequiredDetail('gitea', localizedHostedReviewCopy('gitea'))
    expect(detail).toContain('Gitea')
    expect(detail).toContain('gt auth login')
    expect(detail).toContain('ORCA_GITEA_TOKEN')
  })

  it('mentions gt auth login in the short sign-in hint', () => {
    const hint = hostedReviewSignInHint('gitea')
    expect(hint).toContain('gt auth login')
    expect(hint).toContain('ORCA_GITEA_TOKEN')
  })

  it('keeps Azure DevOps on its token variable only', () => {
    expect(hostedReviewSignInHint('azure-devops')).toContain('ORCA_AZURE_DEVOPS_TOKEN')
  })
})
