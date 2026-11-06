import { useAppStore } from '@/store'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import {
  registerLinearIssueConsumer,
  projectLinearIssue,
  type LinearIssueLease,
  type LinearIssueView
} from '@/store/slices/linear/linear-issue-publication'
import { useLinearCommittedState } from './linear-issue-committed-state'

export function useLinearIssuePublication(
  issue: LinearIssue | null,
  source: RuntimeLinearSettings
) {
  const key = useAppStore(() => getLinearSourceScope(source).contextKey)
  const scope = getLinearSourceScope(source)
  const target = JSON.stringify([key, issue?.id, issue?.workspaceId])
  const seed = useMemo(
    () => ({
      issue: issue ? projectLinearIssue(scope, issue) : null,
      loading: Boolean(issue)
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: target is the complete source/runtime/occurrence identity for this seed.
    [target]
  )
  const saved = useLinearCommittedState(target, seed, scope)
  const { publish, read: consumeRead } = saved
  const consumer = useRef<ReturnType<typeof registerLinearIssueConsumer> | null>(null)
  useLayoutEffect(() => {
    if (!issue) {
      return
    }
    const registration = registerLinearIssueConsumer(scope, issue.id, (publication) => {
      publish(
        (previous, fields) => {
          if (!previous.issue) {
            return previous
          }
          const patch: Partial<LinearIssue> = {}
          for (const field of publication.fields) {
            if (fields?.includes(field)) {
              Object.assign(
                patch,
                field === 'labels'
                  ? { labels: publication.patch.labels, labelIds: publication.patch.labelIds }
                  : { [field]: publication.patch[field] }
              )
            }
          }
          return { ...previous, issue: { ...previous.issue, ...patch } }
        },
        (field) => field !== undefined && publication.current(field),
        { fields: publication.fields }
      )
    })
    consumer.current = registration
    return () => {
      registration.release()
      if (consumer.current === registration) {
        consumer.current = null
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: target owns the complete source/runtime/occurrence, not saved fields.
  }, [target, publish])
  const read = useCallback(
    (
      lease: LinearIssueLease<LinearIssue | null>,
      view: LinearIssueView<LinearIssue | null>,
      seed = false
    ) => {
      const issue =
        view.data && (view.kind === 'data' || seed)
          ? seed
            ? projectLinearIssue(scope, view.data)
            : view.data
          : null
      if (issue) {
        consumeRead(lease, view, () => ({ issue, loading: view.kind === 'loading' }), {
          acknowledge: seed ? undefined : consumer.current?.capture()
        })
      } else if (view.kind === 'abandoned') {
        publish(
          (previous) => ({ ...previous, loading: false }),
          () => true,
          { fields: ['loading'] }
        )
      } else {
        consumeRead(
          lease,
          view,
          (previous) => ({ ...previous, loading: view.kind === 'loading' }),
          {
            fields: ['loading']
          }
        )
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Why: target captures the immutable source/runtime for seed projection.
    [consumeRead, publish, target]
  )
  return {
    issue: saved.value.issue,
    loading: saved.value.loading,
    read,
    isCurrent: saved.isCurrent
  }
}
