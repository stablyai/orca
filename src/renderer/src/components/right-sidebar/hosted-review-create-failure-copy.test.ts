import { afterEach, describe, expect, it } from 'vitest'
import type {
  CreateHostedReviewResult,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { i18n } from '@/i18n/i18n'
import { localizedCreateFailure } from './hosted-review-create-failure-copy'
import { formatCreateError } from './create-pull-request-review-copy'

type FailedResult = Extract<CreateHostedReviewResult, { ok: false }>

function failed(overrides: Partial<FailedResult> = {}): FailedResult {
  return { ok: false, code: 'validation', error: 'English text from the host.', ...overrides }
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('localizedCreateFailure', () => {
  it.each<[HostedReviewProvider, string]>([
    [
      'github',
      'Create PR failed: GitHub is not authenticated. Next step: run gh auth login in this environment.'
    ],
    [
      'gitlab',
      'Create MR failed: GitLab is not authenticated. Next step: run glab auth login in this environment.'
    ],
    [
      'azure-devops',
      'Create PR failed: Azure DevOps is not authenticated. Next step: set ORCA_AZURE_DEVOPS_TOKEN in this environment.'
    ],
    [
      'gitea',
      'Create PR failed: Gitea is not authenticated. Next step: set ORCA_GITEA_TOKEN in this environment.'
    ],
    [
      'bitbucket',
      'Create PR failed: Bitbucket is not authenticated. Next step: connect Bitbucket in Settings > Integrations, or set ORCA_BITBUCKET_* in this environment.'
    ]
  ])('gives %s its own sign-in step', (provider, expected) => {
    expect(
      localizedCreateFailure(failed({ code: 'auth_required', reason: 'auth_required' }), provider)
    ).toBe(expected)
  })

  it('names the base branch that is missing from the remote', () => {
    expect(
      localizedCreateFailure(
        failed({ reason: 'base_not_on_remote', base: 'stacked-parent' }),
        'github'
      )
    ).toBe(
      'Create PR failed: the base branch "stacked-parent" hasn\'t been pushed to the remote. Choose a pushed base or push it first.'
    )
    expect(localizedCreateFailure(failed({ reason: 'base_not_on_remote' }), 'github')).toBe(
      "Create PR failed: the base branch hasn't been pushed to the remote. Choose a pushed base or push it first."
    )
  })

  it.each<[FailedResult['reason'], string]>([
    ['existing_review', 'A merge request already exists for this branch.'],
    ['creation_unconfirmed', 'MR creation may have completed. Refreshing branch review state...'],
    ['unsupported_provider', 'Creating a merge request requires a remote hosted on GitLab.']
  ])('shows %s as a sentence of its own', (reason, expected) => {
    expect(localizedCreateFailure(failed({ reason }), 'gitlab')).toBe(expected)
  })

  it("shows an older host's English error when the result has no reason", () => {
    expect(localizedCreateFailure(failed(), 'github')).toBe('English text from the host.')
  })

  it("shows the host's English error for a reason this build does not know", () => {
    const fromNewerHost: FailedResult = JSON.parse(
      '{"ok":false,"code":"validation","error":"English text from the host.","reason":"future_reason"}'
    )
    expect(localizedCreateFailure(fromNewerHost, 'github')).toBe('English text from the host.')
  })

  it('follows the UI language', async () => {
    await i18n.changeLanguage('ja')
    expect(localizedCreateFailure(failed({ reason: 'dirty' }), 'gitlab')).toBe(
      'MR の作成に失敗しました: MR を作成する前に、ローカルの変更をコミットするか破棄してください。'
    )
  })
})

describe('formatCreateError after a successful push', () => {
  it('reports the localized detail without repeating the create-failed lead-in', () => {
    expect(formatCreateError(failed({ reason: 'needs_push' }), true, 'github')).toBe(
      'Push succeeded, but PR creation failed: push this branch before creating a pull request.'
    )
  })

  it("strips the English lead-in from an older host's error", () => {
    expect(
      formatCreateError(
        failed({ error: 'Create MR failed: GitLab could not create the merge request.' }),
        true,
        'gitlab'
      )
    ).toBe('Push succeeded, but MR creation failed: GitLab could not create the merge request.')
  })
})
