import { afterEach, expect, it, vi } from 'vitest'
import { copyRejectedPipelineEditorDraft, savePipelineEditorDraft } from './pipeline-editor-save'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import { createPipelineEditorDraft, updatePipelineEditorDraft } from './pipeline-editor-draft'
import { pipelineEditorDrafts, pipelineEditorPendingSaves } from './pipeline-editor-cache'
import { writePipelineEditorDraft } from './pipeline-editor-receipts'
import { releasePipelineRetainedInput } from './pipeline-retained-inputs'
import type { PipelineV2DraftReceipt } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'

vi.mock('./pipeline-editor-receipts', () => ({ writePipelineEditorDraft: vi.fn() }))
afterEach(() => {
  pipelineEditorDrafts.clear()
  pipelineEditorPendingSaves.clear()
  vi.resetAllMocks()
})
function draft() {
  const current = updatePipelineEditorDraft(
    createPipelineEditorDraft(pipelineV2TemplateFixture('project-a'), 3),
    { type: 'template', patch: { description: 'Сохранить весь этот текст.' } }
  )
  pipelineEditorDrafts.set('project-a', current)
  return current
}
it.each(['pipeline_revision_conflict', 'pipeline_runtime_identity_changed'])(
  'releases a definitely refused first save while retaining the local draft: %s',
  async (reason) => {
    const before = draft()
    vi.mocked(writePipelineEditorDraft).mockRejectedValue(new Error(reason))
    await expect(savePipelineEditorDraft('project-a', 'runtime-a', () => {})).rejects.toThrow(
      reason
    )
    expect(pipelineEditorPendingSaves.has('project-a')).toBe(false)
    expect(pipelineEditorDrafts.get('project-a')).toMatchObject({
      template: before.template,
      revision: 3,
      dirty: true,
      pending: undefined
    })
    const recovered = copyRejectedPipelineEditorDraft(
      pipelineEditorDrafts.get('project-a')!,
      'recovered-a'
    )
    expect(recovered).toMatchObject({
      draftId: 'recovered-a',
      revision: 0,
      dirty: true,
      template: {
        id: 'recovered-a',
        projectId: 'project-a',
        description: 'Сохранить весь этот текст.'
      }
    })
    expect(recovered.pending).toBeUndefined()
  }
)
it('retains an unknown first save and its exact identity even if a later retry sees another runtime', async () => {
  const before = draft()
  vi.mocked(writePipelineEditorDraft).mockRejectedValueOnce(new Error('Transport disconnected'))
  await expect(savePipelineEditorDraft('project-a', 'runtime-a', () => {})).rejects.toThrow(
    'disconnected'
  )
  const input = pipelineEditorPendingSaves.get('project-a')
  expect(input).toBeDefined()
  vi.mocked(writePipelineEditorDraft).mockRejectedValueOnce(
    new Error('pipeline_runtime_identity_changed')
  )
  await expect(savePipelineEditorDraft('project-a', 'runtime-b', () => {})).rejects.toThrow(
    'identity'
  )
  expect(pipelineEditorPendingSaves.get('project-a')).toEqual(input)
  expect(pipelineEditorDrafts.get('project-a')?.template).toEqual(before.template)
  expect(pipelineEditorDrafts.get('project-a')?.pending?.requestId).toBe(input?.requestId)
  expect(() =>
    copyRejectedPipelineEditorDraft(pipelineEditorDrafts.get('project-a')!, 'new-copy')
  ).toThrow('pipeline_save_recovery_unavailable')
})
it('does not let an older reply overwrite or clear a newer save after local retention recovery', async () => {
  draft()
  const old = Promise.withResolvers<PipelineV2DraftReceipt>()
  const next = Promise.withResolvers<PipelineV2DraftReceipt>()
  vi.mocked(writePipelineEditorDraft)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(next.promise)
  const oldWrite = savePipelineEditorDraft('project-a', 'runtime-a', () => {})
  const original = pipelineEditorPendingSaves.get('project-a')!
  releasePipelineRetainedInput('project:project-a', true)
  pipelineEditorDrafts.set(
    'project-a',
    createPipelineEditorDraft(
      {
        ...pipelineV2TemplateFixture('project-a'),
        id: 'new-local',
        description: 'Новый сохранённый текст'
      },
      0
    )
  )
  const newWrite = savePipelineEditorDraft('project-a', 'runtime-a', () => {})
  const replacement = pipelineEditorPendingSaves.get('project-a')!
  old.resolve({
    projectId: 'project-a',
    requestId: original.requestId,
    draftId: 'development',
    revision: 4,
    draftDigest: 'a'.repeat(64)
  })
  await oldWrite
  expect(pipelineEditorPendingSaves.get('project-a')).toBe(replacement)
  expect(pipelineEditorDrafts.get('project-a')?.template.description).toBe(
    'Новый сохранённый текст'
  )
  next.resolve({
    projectId: 'project-a',
    requestId: replacement.requestId,
    draftId: 'new-local',
    revision: 1,
    draftDigest: 'b'.repeat(64)
  })
  await newWrite
  expect(pipelineEditorDrafts.get('project-a')).toMatchObject({
    draftId: 'new-local',
    revision: 1,
    dirty: false
  })
})
