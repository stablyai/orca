import { describe, expect, it } from 'vitest'
import { authRequiredDetail, hostedReviewSignInHint } from './hosted-review-sign-in-copy'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'

describe('Gitea sign-in copy', () => {
  it('mentions tea login add alongside ORCA_GITEA_TOKEN in the auth-required detail', () => {
    const detail = authRequiredDetail('gitea', localizedHostedReviewCopy('gitea'))
    expect(detail).toContain('Gitea')
    expect(detail).toContain('tea login add')
    expect(detail).toContain('ORCA_GITEA_TOKEN')
  })

  it('mentions tea login add in the short sign-in hint', () => {
    const hint = hostedReviewSignInHint('gitea')
    expect(hint).toContain('tea login add')
    expect(hint).toContain('ORCA_GITEA_TOKEN')
  })

  it('keeps Azure DevOps on its token variable only', () => {
    expect(hostedReviewSignInHint('azure-devops')).toContain('ORCA_AZURE_DEVOPS_TOKEN')
  })
})
