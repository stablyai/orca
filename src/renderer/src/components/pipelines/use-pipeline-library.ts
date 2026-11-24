import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipelineV2TemplateListItem } from '../../../../shared/pipelines/v2/pipeline-v2-library-results'
import { callPipelineRpc } from './pipeline-api'

export function usePipelineLibrary(
  projectId: string,
  enabled: boolean,
  onError: (error: string) => void
) {
  const [items, setItems] = useState<PipelineV2TemplateListItem[]>([])
  const [runtimeId, setRuntimeId] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [checks, setChecks] = useState<string[]>([])
  const cursors = useRef({ drafts: 0, versions: 0 })
  const generation = useRef(0)
  const refresh = useCallback(
    async (append = false) => {
      const epoch = generation.current
      const pages = await Promise.all(
        (['drafts', 'versions'] as const).map((kind) =>
          callPipelineRpc<{
            templates: PipelineV2TemplateListItem[]
            cursor: number
            hasMore: boolean
          }>('pipeline.v2.template.list', {
            projectId,
            kind,
            cursor: append ? cursors.current[kind] : 0,
            limit: 50
          })
        )
      )
      if (generation.current !== epoch) {
        return
      }
      cursors.current = { drafts: pages[0].cursor, versions: pages[1].cursor }
      setHasMore(pages.some((page) => page.hasMore))
      setItems((previous) =>
        append
          ? [
              ...new Map(
                [...previous, ...pages.flatMap((page) => page.templates)].map((item) => [
                  item.kind === 'drafts' ? `draft:${item.id}` : item.selection.digest,
                  item
                ])
              ).values()
            ]
          : pages.flatMap((page) => page.templates)
      )
      setRuntimeId(pages[0].runtimeId)
    },
    [projectId]
  )
  useEffect(() => {
    generation.current += 1
    const epoch = generation.current
    setItems([])
    setRuntimeId('')
    setChecks([])
    if (enabled) {
      void refresh().catch((error) => {
        if (epoch === generation.current) {
          onError(String(error))
        }
      })
      void callPipelineRpc<{ configuredChecks: { id: string }[] }>('pipeline.v2.describe', {
        projectId
      })
        .then((result) => {
          if (epoch === generation.current) {
            setChecks(result.configuredChecks.map((check) => check.id))
          }
        })
        .catch((error) => {
          if (epoch === generation.current) {
            onError(String(error))
          }
        })
    }
    return () => {
      generation.current += 1
    }
  }, [projectId, enabled, refresh, onError])
  return { items, runtimeId, hasMore, checks, refresh }
}
