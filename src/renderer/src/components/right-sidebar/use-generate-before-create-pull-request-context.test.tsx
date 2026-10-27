// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createRunningPullRequestGenerationRecord } from '@/store/slices/pull-request-generation'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'
import { useGenerateBeforeCreatePullRequest } from './use-generate-before-create-pull-request'

const revisions = { base: 0, title: 0, body: 0, draft: 0 }
const eligibility: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found',
  defaultBaseRef: 'main'
}

function seedRecord(key: string) {
  return createRunningPullRequestGenerationRecord(
    {
      worktreeId: key,
      worktreePath: `/repo/${key}`,
      requestId: key === 'a' ? 1 : 2,
      runtimeTarget: { kind: 'local' },
      repoId: 'repo-1',
      branch: key
    },
    { base: 'main', title: `Seed ${key}`, body: `Body ${key}`, draft: false },
    revisions,
    true
  )
}

function useComposer(key: string) {
  const record = useAppStore((state) => state.pullRequestGenerationRecords[key])
  const fields = useCreatePullRequestDialogFields({
    open: true,
    repoId: 'repo-1',
    worktreeId: key,
    worktreePath: `/repo/${key}`,
    branch: key,
    eligibility,
    settings: null,
    target: { kind: 'local' },
    submitting: false,
    generation: {
      generating: record?.status === 'running',
      generateError: null,
      seedRestoreKey: `${key}:${record?.context.requestId}`,
      seed: record?.editedFields?.fields ?? record?.seed,
      seedFieldRevisions: record?.editedFields?.revisions ?? record?.seedFieldRevisions,
      onGenerate: vi.fn(async () => undefined),
      onCancelGenerate: vi.fn()
    }
  })
  useGenerateBeforeCreatePullRequest({
    aiGenerationEnabled: false,
    canCreate: true,
    createPullRequest: vi.fn(async () => {}),
    fields: { base: fields.base, title: fields.title, body: fields.body, draft: fields.draft },
    fieldRevisions: fields.fieldRevisions,
    fieldsInitialized: fields.initializedFromEligibility,
    fieldsAreSeedPlaceholders: fields.fieldsAreSeedPlaceholders,
    generatePullRequestFields: fields.handleGenerate,
    generationKey: key,
    repo: null,
    settings: null
  })
  return fields
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ pullRequestGenerationRecords: {} })
})

describe('auto-submit field ownership during real composer seeding', () => {
  it('does not publish the old composer fields into another pending branch', () => {
    useAppStore.setState({
      pullRequestGenerationRecords: { a: seedRecord('a'), b: seedRecord('b') }
    })
    const { result, rerender } = renderHook(({ key }) => useComposer(key), {
      initialProps: { key: 'a' }
    })
    act(() => {
      result.current.setTitle('Manual A title')
      result.current.setBody('Manual A details')
    })
    expect(useAppStore.getState().pullRequestGenerationRecords.a?.editedFields?.fields.title).toBe(
      'Manual A title'
    )
    rerender({ key: 'b' })
    expect(useAppStore.getState().pullRequestGenerationRecords.b?.editedFields).toBeUndefined()
    expect(result.current.title).toBe('Seed b')
    act(() => result.current.setTitle('Manual B title'))
    rerender({ key: 'a' })
    expect(result.current.title).toBe('Manual A title')
    expect(result.current.body).toBe('Manual A details')
    expect(useAppStore.getState().pullRequestGenerationRecords.b?.editedFields?.fields.title).toBe(
      'Manual B title'
    )
  })
})
