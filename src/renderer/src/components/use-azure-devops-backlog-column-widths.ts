import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AzureDevOpsBacklogColumnField } from '../../../shared/azure-devops/boards-types'
import { applyAzureDevOpsColumnWidths } from './task-page-azure-devops-backlog-columns'

export type AzureDevOpsColumnWidthSettings = {
  azureDevOpsBacklogColumnWidths: Record<string, Record<string, number>> | null
}

const NO_WIDTHS: Readonly<Record<string, number>> = {}

/**
 * Local column widths over the ADO ones. Drags stream into a draft; the draft is
 * written to settings once on mouse-up so a drag is not a burst of settings writes.
 */
export function useAzureDevOpsBacklogColumnWidths(args: {
  /** `azureDevOpsColumnWidthKey` for the current (project, team, level); null until known. */
  widthKey: string | null
  columns: AzureDevOpsBacklogColumnField[]
  settings: AzureDevOpsColumnWidthSettings | null | undefined
  updateSettings: (patch: AzureDevOpsColumnWidthSettings) => Promise<unknown>
}): {
  columns: AzureDevOpsBacklogColumnField[]
  hasOverrides: boolean
  onResizeColumn: (referenceName: string, width: number) => void
  onResizeEnd: () => void
  resetColumnWidths: () => void
} {
  const { widthKey, columns, settings, updateSettings } = args
  const [draft, setDraft] = useState<{ key: string; widths: Record<string, number> } | null>(null)
  const persisted = settings?.azureDevOpsBacklogColumnWidths ?? null
  const persistedForKey = (widthKey && persisted?.[widthKey]) || NO_WIDTHS
  const overrides = useMemo(
    () =>
      draft && draft.key === widthKey ? { ...persistedForKey, ...draft.widths } : persistedForKey,
    [draft, widthKey, persistedForKey]
  )

  const write = useCallback(
    (next: Record<string, Record<string, number>> | null) => {
      void updateSettings({ azureDevOpsBacklogColumnWidths: next }).catch((error: unknown) => {
        toast.error(
          translate(
            'auto.components.TaskPage.azureDevOps.columnWidthsSaveFailed',
            'Couldn’t save the column widths: {{value0}}',
            { value0: error instanceof Error ? error.message : String(error) }
          )
        )
      })
    },
    [updateSettings]
  )

  const onResizeColumn = useCallback(
    (referenceName: string, width: number) => {
      if (!widthKey) {
        return
      }
      setDraft((current) => ({
        key: widthKey,
        widths: {
          ...(current && current.key === widthKey ? current.widths : {}),
          [referenceName]: Math.round(width)
        }
      }))
    },
    [widthKey]
  )

  const onResizeEnd = useCallback(() => {
    if (!widthKey || !draft || draft.key !== widthKey) {
      return
    }
    write({ ...persisted, [widthKey]: { ...persistedForKey, ...draft.widths } })
    // Why: the draft stays until settings echo back, so the header never snaps to the old width.
  }, [widthKey, draft, persisted, persistedForKey, write])

  const resetColumnWidths = useCallback(() => {
    setDraft(null)
    if (!widthKey || !persisted?.[widthKey]) {
      return
    }
    const { [widthKey]: _dropped, ...rest } = persisted
    write(Object.keys(rest).length > 0 ? rest : null)
  }, [widthKey, persisted, write])

  return {
    columns: useMemo(() => applyAzureDevOpsColumnWidths(columns, overrides), [columns, overrides]),
    hasOverrides: Object.keys(overrides).length > 0,
    onResizeColumn,
    onResizeEnd,
    resetColumnWidths
  }
}
