import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  parseWorkflowPresetText,
  serializeWorkflowPresetForExport
} from '../../../../shared/workflow/workflow-preset-migration'
import type { WorkflowPreset } from '../../../../shared/workflow/workflow-definition-schema'
import { isWorkflowDraftDirty, useWorkflowEditorStore } from './workflow-editor-store'
import { createBlankWorkflowPreset } from './workflow-editor-mutations'
import { workflowRpc } from './workflow-rpc'
import { pickWorkflowTextFile, saveWorkflowTextFile } from './workflow-file-export'
import { useWorkflowRunViewStore } from './workflow-run-view-store'
import { translate } from '@/i18n/i18n'

const LAST_PRESET_KEY = 'orca.workflows.lastPresetId'

function freshId(): string {
  return `wf-${createBrowserUuid().slice(0, 8)}`
}

function rememberPreset(id: string): void {
  try {
    localStorage.setItem(LAST_PRESET_KEY, id)
  } catch {
    // Storage can be unavailable; reopening the first template is an acceptable fallback.
  }
}

export function useWorkflowPresets() {
  const confirm = useConfirmationDialog()
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [loading, setLoading] = useState(true)
  const load = useWorkflowEditorStore((state) => state.load)
  const markSaved = useWorkflowEditorStore((state) => state.markSaved)

  const refresh = useCallback(async (): Promise<WorkflowPreset[]> => {
    const result = await workflowRpc.listPresets()
    setPresets(result.presets)
    return result.presets
  }, [])

  const guardDirty = useCallback(async (): Promise<boolean> => {
    if (!isWorkflowDraftDirty(useWorkflowEditorStore.getState())) {
      return true
    }
    return confirm({
      title: translate(
        'auto.components.workflows.use.workflow.presets.4d4a155641',
        'Discard unsaved changes?'
      ),
      description: translate(
        'auto.components.workflows.use.workflow.presets.d25512379d',
        'This workflow has edits that are not saved.'
      ),
      confirmLabel: 'Discard',
      confirmVariant: 'destructive'
    })
  }, [confirm])

  const open = useCallback(
    async (preset: WorkflowPreset, options: { saved?: boolean } = {}): Promise<void> => {
      if (!(await guardDirty())) {
        return
      }
      load(preset, { saved: options.saved ?? true })
      useWorkflowEditorStore.getState().setMode('design')
      useWorkflowRunViewStore.getState().clear()
      rememberPreset(preset.id)
    },
    [guardDirty, load]
  )

  useEffect(() => {
    let cancelled = false
    refresh()
      .then((list) => {
        if (cancelled || useWorkflowEditorStore.getState().preset) {
          return
        }
        let lastId: string | null = null
        try {
          lastId = localStorage.getItem(LAST_PRESET_KEY)
        } catch {
          lastId = null
        }
        const initial =
          list.find((preset) => preset.id === lastId) ??
          list.find((preset) => preset.id === 'template-authentication-feature') ??
          list[0]
        if (initial) {
          load(initial, { saved: true })
        }
      })
      .catch((error: unknown) =>
        toast.error(
          translate(
            'auto.components.workflows.use.workflow.presets.2715a3f7a3',
            'Could not load workflows'
          ),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [load, refresh])

  const persist = useCallback(
    async (preset: WorkflowPreset): Promise<WorkflowPreset | null> => {
      try {
        const saved = (await workflowRpc.savePreset(preset)).preset
        markSaved(saved)
        rememberPreset(saved.id)
        await refresh()
        return saved
      } catch (error) {
        toast.error(
          translate('auto.components.workflows.use.workflow.presets.5d1e18650e', 'Save failed'),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
        return null
      }
    },
    [markSaved, refresh]
  )

  const saveAs = useCallback(
    async (name?: string): Promise<void> => {
      const draft = useWorkflowEditorStore.getState().preset
      if (draft) {
        const now = new Date().toISOString()
        await persist({
          ...draft,
          id: freshId(),
          name: name ?? `${draft.name} copy`,
          template: false,
          createdAt: now,
          updatedAt: now
        })
      }
    },
    [persist]
  )

  const save = useCallback(async (): Promise<void> => {
    const draft = useWorkflowEditorStore.getState().preset
    if (!draft) {
      return
    }
    // Templates stay read-only; saving one keeps its name on a new copy.
    if (draft.template) {
      await saveAs(draft.name)
      return
    }
    await persist(draft)
  }, [persist, saveAs])

  const remove = useCallback(async (): Promise<void> => {
    const draft = useWorkflowEditorStore.getState().preset
    if (!draft || draft.template) {
      return
    }
    const accepted = await confirm({
      title: translate(
        'auto.components.workflows.use.workflow.presets.a2669363ae',
        'Delete {{value0}}?',
        { value0: draft.name }
      ),
      description: translate(
        'auto.components.workflows.use.workflow.presets.51183c61a9',
        'The preset is removed from this computer. Past runs keep their own frozen copy.'
      ),
      confirmLabel: 'Delete',
      confirmVariant: 'destructive'
    })
    if (!accepted) {
      return
    }
    await workflowRpc.deletePreset(draft.id)
    const list = await refresh()
    const next = list[0]
    if (next) {
      load(next, { saved: true })
    }
  }, [confirm, load, refresh])

  const createNew = useCallback(async (): Promise<void> => {
    await open(createBlankWorkflowPreset(freshId(), new Date().toISOString()), { saved: false })
  }, [open])

  const importFile = useCallback(async (): Promise<void> => {
    const text = await pickWorkflowTextFile('application/json,.json')
    if (text === null) {
      return
    }
    const parsed = parseWorkflowPresetText(text)
    if (!parsed.ok) {
      toast.error(
        translate('auto.components.workflows.use.workflow.presets.157f814dbc', 'Import failed'),
        { description: parsed.error }
      )
      return
    }
    // An import never overwrites a preset or a template by id.
    const now = new Date().toISOString()
    await open(
      { ...parsed.preset, id: freshId(), template: false, createdAt: now, updatedAt: now },
      { saved: false }
    )
    toast.success(
      translate(
        'auto.components.workflows.use.workflow.presets.bfe495c562',
        'Imported {{value0}}',
        { value0: parsed.preset.name }
      ),
      {
        description: parsed.migratedFrom
          ? translate(
              'auto.components.workflows.use.workflow.presets.4e77085adb',
              'Migrated from schema v{{value0}}. Save to keep it.',
              { value0: parsed.migratedFrom }
            )
          : translate(
              'auto.components.workflows.use.workflow.presets.1cbc73f669',
              'Save to keep it.'
            )
      }
    )
  }, [open])

  const exportFile = useCallback(async (): Promise<void> => {
    const draft = useWorkflowEditorStore.getState().preset
    if (!draft) {
      return
    }
    const { text, redactions } = serializeWorkflowPresetForExport(draft)
    if (redactions > 0) {
      toast.warning(
        translate(
          'auto.components.workflows.use.workflow.presets.ebc589a822',
          'Redacted {{value0}} credential-like value{{value1}} from the export.',
          { value0: redactions, value1: redactions === 1 ? '' : 's' }
        )
      )
    }
    await saveWorkflowTextFile(text, draft.name, 'json')
  }, [])

  return { presets, loading, open, save, saveAs, remove, createNew, importFile, exportFile }
}

export type WorkflowPresetControls = ReturnType<typeof useWorkflowPresets>
