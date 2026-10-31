import { useCallback, useEffect, useRef, useState } from 'react'
import { jiraGetIssueEditFieldsForTarget } from '@/runtime/runtime-jira-client'
import type { JiraEditField } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type JiraIssueEditFieldsState = {
  // null until loaded, and when a remote host cannot serve edit-screen fields.
  fields: JiraEditField[] | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

type Snapshot = Omit<JiraIssueEditFieldsState, 'reload'> & { requestKey: string | null }

const EMPTY_SNAPSHOT: Snapshot = { requestKey: null, fields: null, loading: false, error: null }

export function useJiraIssueEditFields({
  issueKey,
  siteId,
  owner,
  requestKey
}: {
  issueKey: string | undefined
  siteId: string | undefined
  owner: RuntimeClientTarget
  requestKey: string | null
}): JiraIssueEditFieldsState {
  // Why: keyed by issue so another issue never shows these fields, without
  // resetting state from an effect when the selection changes.
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT)
  const readIdRef = useRef(0)
  const loadedRequestKeyRef = useRef<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (!issueKey || !requestKey) {
      return
    }
    const readId = ++readIdRef.current
    const keep = (current: Snapshot): JiraEditField[] | null =>
      current.requestKey === requestKey ? current.fields : null
    setSnapshot((current) => ({ requestKey, fields: keep(current), loading: true, error: null }))
    try {
      const fields = await jiraGetIssueEditFieldsForTarget(owner, issueKey, siteId)
      if (readId === readIdRef.current) {
        setSnapshot({ requestKey, fields, loading: false, error: null })
      }
    } catch (loadError) {
      if (readId === readIdRef.current) {
        const error = loadError instanceof Error ? loadError.message : 'Failed to load Jira fields.'
        setSnapshot((current) => ({ requestKey, fields: keep(current), loading: false, error }))
      }
    }
  }, [issueKey, owner, requestKey, siteId])

  useEffect(() => {
    if (loadedRequestKeyRef.current === requestKey) {
      return
    }
    loadedRequestKeyRef.current = requestKey
    readIdRef.current += 1
    if (requestKey) {
      void reload()
    }
  }, [reload, requestKey])

  useEffect(
    () => () => {
      readIdRef.current += 1
      loadedRequestKeyRef.current = null
    },
    []
  )

  const current = snapshot.requestKey === requestKey ? snapshot : EMPTY_SNAPSHOT
  return { fields: current.fields, loading: current.loading, error: current.error, reload }
}
