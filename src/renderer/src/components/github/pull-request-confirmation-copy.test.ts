import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setRendererUiLanguage } from '@/i18n/i18n'
import {
  getPullRequestMergeConfirmationTitle,
  getPullRequestMergeMethodLabel,
  getPullRequestStateConfirmationTitle
} from './pull-request-confirmation-copy'

beforeEach(async () => {
  await setRendererUiLanguage('en')
})

afterEach(async () => {
  await setRendererUiLanguage('en')
})

describe('pull request confirmation copy', () => {
  it('uses complete English confirmation sentences and merge labels', () => {
    expect(getPullRequestStateConfirmationTitle('closed', 123)).toBe('Close PR #123?')
    expect(getPullRequestStateConfirmationTitle('open', 123)).toBe('Reopen PR #123?')
    expect(getPullRequestMergeConfirmationTitle('merge', 123)).toBe(
      'Merge PR #123 with a merge commit?'
    )
    expect(getPullRequestMergeConfirmationTitle('squash', 123)).toBe('Squash and merge PR #123?')
    expect(getPullRequestMergeConfirmationTitle('rebase', 123)).toBe('Rebase and merge PR #123?')
    expect(getPullRequestMergeMethodLabel('merge')).toBe('Create merge commit')
    expect(getPullRequestMergeMethodLabel('squash')).toBe('Squash and merge')
    expect(getPullRequestMergeMethodLabel('rebase')).toBe('Rebase and merge')
  })

  it('loads the approved Korean sentences and merge terminology', async () => {
    await setRendererUiLanguage('ko')

    expect(getPullRequestStateConfirmationTitle('closed', 123)).toBe('PR #123을 닫으시겠습니까?')
    expect(getPullRequestStateConfirmationTitle('open', 123)).toBe('PR #123을 다시 여시겠습니까?')
    expect(getPullRequestMergeConfirmationTitle('merge', 123)).toBe(
      '병합 커밋을 생성하여 PR #123을 병합하시겠습니까?'
    )
    expect(getPullRequestMergeConfirmationTitle('squash', 123)).toBe(
      'PR #123을 스쿼시하여 병합하시겠습니까?'
    )
    expect(getPullRequestMergeConfirmationTitle('rebase', 123)).toBe(
      'PR #123을 리베이스하여 병합하시겠습니까?'
    )
    expect(getPullRequestMergeMethodLabel('merge')).toBe('병합 커밋 생성')
    expect(getPullRequestMergeMethodLabel('squash')).toBe('스쿼시 및 병합')
    expect(getPullRequestMergeMethodLabel('rebase')).toBe('리베이스 및 병합')
  })

  it('uses the current renderer language and actual pull request number after switching', async () => {
    expect(getPullRequestMergeConfirmationTitle('squash', 9294)).toBe('Squash and merge PR #9294?')

    await setRendererUiLanguage('ko')
    expect(getPullRequestStateConfirmationTitle('open', 28185)).toBe(
      'PR #28185을 다시 여시겠습니까?'
    )
    expect(getPullRequestMergeConfirmationTitle('squash', 9294)).toBe(
      'PR #9294을 스쿼시하여 병합하시겠습니까?'
    )
    expect(getPullRequestMergeMethodLabel('squash')).toBe('스쿼시 및 병합')

    await setRendererUiLanguage('en')
    expect(getPullRequestStateConfirmationTitle('open', 28185)).toBe('Reopen PR #28185?')
    expect(getPullRequestMergeConfirmationTitle('squash', 9294)).toBe('Squash and merge PR #9294?')
    expect(getPullRequestMergeMethodLabel('squash')).toBe('Squash and merge')
  })
})
