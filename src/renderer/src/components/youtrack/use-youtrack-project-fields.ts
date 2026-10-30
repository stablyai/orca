import { useEffect, useState } from 'react'
import type { YouTrackFieldSchema } from '../../../../shared/youtrack-types'

// Why module-level: the sheet and the create dialog read the same project schema.
const schemaCache = new Map<string, YouTrackFieldSchema[]>()

type ProjectFieldsState = {
  fields: YouTrackFieldSchema[] | null
  error: string | null
}

export function useYouTrackProjectFields(projectId: string | null): ProjectFieldsState {
  const [state, setState] = useState<ProjectFieldsState>(() => ({
    fields: projectId ? (schemaCache.get(projectId) ?? null) : null,
    error: null
  }))

  useEffect(() => {
    const api = window.api?.youtrack
    if (!projectId || !api) {
      setState({ fields: null, error: null })
      return
    }
    const cached = schemaCache.get(projectId)
    setState({ fields: cached ?? null, error: null })
    if (cached) {
      return
    }
    let cancelled = false
    void api.getProjectFields({ projectId }).then((result) => {
      if (cancelled) {
        return
      }
      if (result.ok) {
        schemaCache.set(projectId, result.fields)
        setState({ fields: result.fields, error: null })
      } else {
        setState({ fields: null, error: result.error })
      }
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return state
}

export function clearYouTrackProjectFieldsCache(): void {
  schemaCache.clear()
}

/** Option-backed kinds are edited with a picker; the rest with a typed input. */
export function isOptionKind(field: YouTrackFieldSchema): boolean {
  return ['enum', 'user', 'version', 'build', 'owned'].includes(field.kind)
}

export function isEditableKind(field: YouTrackFieldSchema): boolean {
  return (
    isOptionKind(field) ||
    ['string', 'integer', 'float', 'date', 'datetime', 'period', 'text'].includes(field.kind)
  )
}
