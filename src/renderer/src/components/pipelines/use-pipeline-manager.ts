import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  PipelineV2TemplateListItem,
  PipelineV2TemplateShowResult
} from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import type { PipelineV2Definition } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2TemplateSaveParams } from '../../../../shared/rpc-contract/pipeline-v2-params'
import {
  createCustomPipelineEditorDraft,
  createPipelineEditorDraft,
  updatePipelineEditorDraft,
  type PipelineEditorAction
} from './pipeline-editor-draft'
import { writePipelineEditorDraft } from './pipeline-editor-receipts'
import { savePipelineEditorDraft, recoverPipelineEditorDraft } from './pipeline-editor-save'
import { deletePipelineEditorDraft } from './pipeline-editor-delete'
import { settlePipelineManagerRequest } from './pipeline-manager-request'
import {
  publishPipelineEditor,
  changePipelineEditorAvailability
} from './pipeline-template-owner-writes'
import { usePipelineLibrary } from './use-pipeline-library'
import { callPipelineRpc } from './pipeline-api'

import {
  pipelineEditorDrafts as drafts,
  pipelineEditorPendingCreates as pendingCreates,
  pipelineEditorPendingDeletes as pendingDeletes,
  pipelineEditorHasPending,
  rememberPipelineEditor as remember,
  retainPipelineEditorProject
} from './pipeline-editor-cache'

export function usePipelineManager(projectId: string, enabled = true) {
  useEffect(
    () => (enabled ? retainPipelineEditorProject(projectId) : undefined),
    [projectId, enabled]
  )
  const t = useTranslate()
  const [editor, setEditor] = useState(() => drafts.get(projectId))
  const [preview, setPreview] = useState<PipelineV2Definition>()
  const [launchPreview, setLaunchPreview] =
    useState<PipelineV2TemplateShowResult['launchPreview']>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const scope = useRef(projectId)
  useLayoutEffect(() => {
    scope.current = projectId
  }, [projectId])
  const { items, runtimeId, hasMore, checks, refresh } = usePipelineLibrary(
    projectId,
    enabled,
    setError
  )
  const [editorProject, setEditorProject] = useState(projectId)
  if (editorProject !== projectId) {
    setLaunchPreview(undefined)
    setEditorProject(projectId)
    setEditor(drafts.get(projectId))
    setPreview(undefined)
    setError('')
    setBusy(false)
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    await settlePipelineManagerRequest(
      action,
      (error) => {
        if (scope.current === projectId) {
          setError(error instanceof Error ? error.message : String(error))
        }
      },
      () => {
        if (scope.current === projectId) {
          setBusy(false)
        }
      }
    )
  }
  const edit = (action: PipelineEditorAction) => {
    if (pendingDeletes.has(projectId)) {
      return
    }
    setLaunchPreview(undefined)
    if (editor?.projectId === projectId) {
      setEditor(remember(updatePipelineEditorDraft(editor, action)))
    }
  }
  const open = async (item: PipelineV2TemplateListItem) => {
    if (editor?.dirty && editor.draftId !== item.id) {
      throw new Error(
        t('pipelines.saveBeforeOpen', 'Save the current draft before opening another template.')
      )
    }
    const shown = await callPipelineRpc<PipelineV2TemplateShowResult>('pipeline.v2.template.show', {
      projectId,
      ...(item.kind === 'drafts' ? { draftId: item.id } : { selection: item.selection }),
      full: true
    })
    if (scope.current !== projectId) {
      return
    }
    if (!shown.record) {
      throw new Error(
        t(
          'pipelines.templateUnavailable',
          'This template is unavailable. Refresh the library and try again.'
        )
      )
    }
    setLaunchPreview(shown.launchPreview)
    if ('draft' in shown.record) {
      setEditor(
        remember(
          drafts.get(projectId)?.draftId === item.id &&
            (drafts.get(projectId)?.dirty || drafts.get(projectId)?.pending)
            ? drafts.get(projectId)!
            : createPipelineEditorDraft(shown.record.draft, shown.record.revision)
        )
      )
      setPreview(undefined)
    } else {
      setPreview(shown.record.definition)
    }
  }
  const create = async (
    source: Extract<PipelineV2TemplateSaveParams, { source: unknown }>['source']
  ) => {
    if (editor?.dirty || editor?.pending || pendingDeletes.has(projectId)) {
      throw new Error(
        t('pipelines.saveBeforeCreate', 'Save the current draft before creating another template.')
      )
    }
    const retry = pendingCreates.has(projectId)
    let input = pendingCreates.get(projectId)
    if (input && JSON.stringify(input.source) !== JSON.stringify(source)) {
      throw new Error(
        t(
          'pipelines.checkPreviousCreation',
          'Check the result of the previous template creation before starting another one.'
        )
      )
    }
    if (!input) {
      if (pendingCreates.size >= 8) {
        throw new Error(
          t(
            'pipelines.checkCreationBeforeProject',
            'Check an unfinished template creation before opening another project.'
          )
        )
      }
      input = {
        projectId,
        id: `template-${createBrowserUuid()}`,
        requestId: createBrowserUuid(),
        expectedRevision: 0,
        expectedRuntimeId: runtimeId,
        source
      }
      pendingCreates.set(projectId, input)
    }
    const result = { receipt: await writePipelineEditorDraft(input, retry) }
    const shown = await callPipelineRpc<PipelineV2TemplateShowResult>('pipeline.v2.template.show', {
      projectId,
      draftId: result.receipt.draftId,
      full: true
    })
    if (pendingCreates.get(projectId) !== input) {
      return
    }
    if (shown.record && 'draft' in shown.record) {
      pendingCreates.delete(projectId)
    }
    if (scope.current === projectId && shown.record && 'draft' in shown.record) {
      setEditor(remember(createPipelineEditorDraft(shown.record.draft, shown.record.revision)))
      setPreview(undefined)
      await refresh()
    }
  }
  const createCustom = () => {
    setLaunchPreview(undefined)
    if (editor?.dirty || editor?.pending || pipelineEditorHasPending(projectId)) {
      throw new Error(
        t(
          'pipelines.saveOrCheckCreation',
          'Save the current draft or check its unfinished creation first.'
        )
      )
    }
    setEditor(
      remember(
        createCustomPipelineEditorDraft(projectId, t('pipelines.customWorkflow', 'Custom workflow'))
      )
    )
    setPreview(undefined)
  }
  const save = async () => {
    if (pendingDeletes.has(projectId)) {
      throw new Error('pipeline_delete_pending')
    }
    if (!editor || editor.projectId !== projectId) {
      return
    }
    await savePipelineEditorDraft(projectId, runtimeId, (next) => {
      if (scope.current === projectId) {
        setEditor(next)
      }
    })
    await refresh()
  }
  const recoverSave = async () => {
    await refresh()
    const recovered = recoverPipelineEditorDraft(projectId)
    if (scope.current === projectId && recovered) {
      setEditor(recovered)
      setPreview(undefined)
      setLaunchPreview(undefined)
    }
  }
  const validate = async () => {
    if (!editor || editor.dirty || editor.pending || pendingDeletes.has(projectId)) {
      throw new Error(
        t('pipelines.saveBeforeValidate', 'Save this draft before validating or publishing it.')
      )
    }
    await callPipelineRpc('pipeline.v2.template.validate', {
      projectId,
      draftId: editor.draftId,
      expectedRevision: editor.revision,
      expectedRuntimeId: runtimeId
    })
    const shown = await callPipelineRpc<PipelineV2TemplateShowResult>('pipeline.v2.template.show', {
      projectId,
      draftId: editor.draftId,
      expectedRuntimeId: runtimeId,
      full: true
    })
    if (scope.current === projectId) {
      setLaunchPreview(shown.launchPreview)
    }
  }
  const publish = async () => {
    await validate()
    const selected = drafts.get(projectId)!
    await publishPipelineEditor(projectId, selected.draftId, selected.revision)
    await refresh().catch((error) => setError(String(error)))
  }
  const toggle = async (item: Extract<PipelineV2TemplateListItem, { kind: 'versions' }>) => {
    await changePipelineEditorAvailability(item)
    await refresh().catch((error) => setError(String(error)))
  }
  const reset = () => {
    if (pipelineEditorHasPending(projectId)) {
      throw new Error('pipeline_editor_action_pending')
    }
    edit({ type: 'reset' })
  }
  const remove = async (draftId: string, revision: number) => {
    await deletePipelineEditorDraft(projectId, runtimeId, draftId, revision)
    if (scope.current === projectId) {
      setEditor(drafts.get(projectId))
      setLaunchPreview(undefined)
      await refresh()
    }
  }
  return {
    editor: editor?.projectId === projectId ? editor : undefined,
    preview,
    launchPreview,
    items,
    checks,
    error,
    busy,
    runtimeId,
    hasMore,
    edit,
    run,
    refresh,
    open,
    create,
    createCustom,
    save,
    recoverSave,
    validate,
    publish,
    toggle,
    reset,
    remove,
    pendingDelete: pendingDeletes.get(projectId),
    hasPending: pipelineEditorHasPending(projectId),
    clearPreview: () => setPreview(undefined)
  }
}
