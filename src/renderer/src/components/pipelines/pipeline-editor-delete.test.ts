import { afterEach, expect, it, vi } from 'vitest'
import { deletePipelineEditorDraft } from './pipeline-editor-delete'
import { callPipelineRpc } from './pipeline-api'
import { readPipelineEditorReceipt } from './pipeline-editor-receipts'
import { pipelineEditorDrafts, pipelineEditorPendingDeletes } from './pipeline-editor-cache'
import { createPipelineEditorDraft } from './pipeline-editor-draft'
import { researchPipelineV2Seed } from '../../../../main/runtime/pipelines/v2/pipeline-v2-seeds'

vi.mock('./pipeline-api', () => ({ callPipelineRpc: vi.fn() }))
vi.mock('./pipeline-editor-receipts', () => ({ readPipelineEditorReceipt: vi.fn() }))
afterEach(() => {
  pipelineEditorDrafts.clear()
  pipelineEditorPendingDeletes.clear()
  vi.resetAllMocks()
})
it('recovers a lost deletion reply from the exact receipt without another deletion or clearing a different draft', async () => {
  pipelineEditorDrafts.set(
    'project-a',
    createPipelineEditorDraft(researchPipelineV2Seed('project-a'), 3)
  )
  vi.mocked(readPipelineEditorReceipt).mockResolvedValue(null)
  vi.mocked(callPipelineRpc).mockRejectedValue(new Error('Transport disconnected'))
  await expect(deletePipelineEditorDraft('project-a', 'runtime-a', 'research', 3)).rejects.toThrow(
    'disconnected'
  )
  const input = pipelineEditorPendingDeletes.get('project-a')!
  vi.mocked(callPipelineRpc).mockRejectedValue(new Error('pipeline_runtime_identity_changed'))
  await expect(deletePipelineEditorDraft('project-a', 'runtime-b', 'research', 3)).rejects.toThrow(
    'identity'
  )
  expect(pipelineEditorPendingDeletes.get('project-a')).toEqual(input)
  const replacement = createPipelineEditorDraft(
    { ...researchPipelineV2Seed('project-a'), id: 'another-draft' },
    0
  )
  pipelineEditorDrafts.set('project-a', replacement)
  vi.mocked(readPipelineEditorReceipt).mockResolvedValue({
    action: 'deleted',
    projectId: 'project-a',
    draftId: 'research',
    revision: 3,
    requestId: input.requestId,
    draftDigest: 'a'.repeat(64)
  })
  vi.mocked(callPipelineRpc).mockClear()
  await deletePipelineEditorDraft('project-a', 'runtime-b', 'research', 3)
  expect(callPipelineRpc).not.toHaveBeenCalled()
  expect(pipelineEditorDrafts.get('project-a')?.draftId).toBe('another-draft')
  expect(pipelineEditorPendingDeletes.has('project-a')).toBe(false)
})
it('rejects a save receipt as deletion evidence and preserves the pending identity', async () => {
  vi.mocked(readPipelineEditorReceipt).mockResolvedValue({
    projectId: 'project-a',
    draftId: 'research',
    revision: 3,
    requestId: 'unrelated',
    draftDigest: 'a'.repeat(64)
  })
  await expect(deletePipelineEditorDraft('project-a', 'runtime-a', 'research', 3)).rejects.toThrow()
  expect(pipelineEditorPendingDeletes.get('project-a')?.draftId).toBe('research')
  expect(callPipelineRpc).not.toHaveBeenCalled()
})
