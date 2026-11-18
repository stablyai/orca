import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

export type TaskCreationDraftSnapshot<Draft, Signature> = {
  signature: Signature | undefined
  draft: Draft
}
type TaskCreationDraftRetentionOptions<Draft, Signature> = {
  open: boolean
  draft: Draft
  writeDraft: (draft: Draft | null, expected?: Draft) => void
  signature?: Signature
  sameSignature?: (a: Signature, b: Signature) => boolean
}

export function useTaskCreationDraftRetention<Draft, Signature = Draft>({
  open,
  draft,
  writeDraft,
  signature,
  sameSignature
}: TaskCreationDraftRetentionOptions<Draft, Signature>) {
  const draftRef = useRef<TaskCreationDraftSnapshot<Draft, Signature>>({ signature, draft })
  const writeDraftRef = useRef(writeDraft)
  const discardRef = useRef<TaskCreationDraftSnapshot<Draft, Signature> | null>(null)

  useLayoutEffect(() => {
    writeDraftRef.current = writeDraft
    if (!open && signature === undefined) {
      return
    }
    const previous = draftRef.current
    if (
      signature !== undefined &&
      previous.signature !== undefined &&
      (sameSignature
        ? sameSignature(previous.signature, signature)
        : Object.is(previous.signature, signature))
    ) {
      return
    }
    const next = { signature, draft }
    draftRef.current = next
    // Why: generic immediate discard keeps its existing open-instance contract.
    discardRef.current = signature === undefined && discardRef.current === previous ? next : null
    // Why: a later committed closing result replaces the projection after close cleanup.
    if (!open && signature !== undefined) {
      writeDraftRef.current(next.draft)
    }
  })
  useEffect(() => {
    if (!open) {
      return
    }
    if (draftRef.current.signature === undefined) {
      discardRef.current = null
    }
    return () => {
      if (discardRef.current !== draftRef.current) {
        writeDraftRef.current(draftRef.current.draft)
      }
    }
  }, [open])
  const discard = useCallback(() => {
    discardRef.current = draftRef.current
    writeDraftRef.current(null)
  }, [])
  const capture = useCallback(() => draftRef.current, [])
  const complete = useCallback((submitted: TaskCreationDraftSnapshot<Draft, Signature>) => {
    if (draftRef.current === submitted) {
      discardRef.current = submitted
      writeDraftRef.current(null)
    } else {
      writeDraftRef.current(null, submitted.draft)
    }
  }, [])
  return Object.assign(discard, { capture, complete })
}

export type LinearIssueFormSignature = {
  occurrence: object
  titleContributor: object
  bodyContributor: object
  title: string
  body: string
}
export const sameLinearIssueFormSignature = (
  a: LinearIssueFormSignature,
  b: LinearIssueFormSignature
) =>
  a.occurrence === b.occurrence &&
  a.titleContributor === b.titleContributor &&
  a.bodyContributor === b.bodyContributor &&
  a.title === b.title &&
  a.body === b.body
export const linearIssueFormPickerDefaults: Pick<
  LinearIssueForm,
  'stateId' | 'assigneeId' | 'priority' | 'projectId' | 'labelIds'
> = { stateId: null, assigneeId: null, priority: 0, projectId: null, labelIds: [] }
export type LinearIssueForm = LinearIssueFormSignature & {
  open: boolean
  runtime: string
  attempt: object | null
  stateId: string | null
  assigneeId: string | null
  priority: number
  projectId: string | null
  labelIds: string[]
  retirement: LinearIssueFormSignature | null
}
export const linearIssueFormSignature = (value: LinearIssueForm): LinearIssueFormSignature => ({
  occurrence: value.occurrence,
  titleContributor: value.titleContributor,
  bodyContributor: value.bodyContributor,
  title: value.title,
  body: value.body
})
export function handoffLinearIssueForm(
  previous: LinearIssueForm,
  runtime: string
): LinearIssueForm {
  if (previous.runtime === runtime) {
    return previous
  }
  return {
    ...previous,
    runtime,
    attempt: null,
    ...(previous.open
      ? {
          ...linearIssueFormPickerDefaults,
          open: false,
          title: '',
          body: '',
          retirement: linearIssueFormSignature(previous)
        }
      : {})
  }
}

export function completeLinearIssueForm(
  previous: LinearIssueForm,
  runtime: string,
  target: string,
  submitted: LinearIssueFormSignature | undefined
): LinearIssueForm {
  return target === runtime &&
    previous.runtime === runtime &&
    submitted &&
    sameLinearIssueFormSignature(previous, submitted)
    ? {
        ...previous,
        ...linearIssueFormPickerDefaults,
        open: false,
        title: '',
        body: '',
        retirement: linearIssueFormSignature(previous)
      }
    : previous
}
