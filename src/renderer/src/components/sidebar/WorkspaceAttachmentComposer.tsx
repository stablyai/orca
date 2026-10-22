import React, { useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import type { AttachmentInputKind } from './worktree-attachment-editing'
import { WorkspaceAttachmentSearch } from './WorkspaceAttachmentSearch'

export type WorkspaceAttachmentComposerProps = {
  items: readonly WorkspaceAttachment[]
  repo?: Repo
  workspace?: Worktree
  disabled: boolean
  initialKind: AttachmentInputKind
  initialInput?: string
  inputRef: React.RefObject<HTMLInputElement | null>
  onAdd: (item: WorkspaceAttachment) => boolean
  onSave: () => void
  getScopeError: (item: WorkspaceAttachment) => string | null
  error: string | null
  onQueryChange: () => void
}

export function WorkspaceAttachmentComposer(
  props: WorkspaceAttachmentComposerProps
): React.JSX.Element {
  const [query, setQuery] = useState(props.initialInput ?? '')
  const [kind, setKind] = useState(props.initialKind)
  const [retryGeneration, setRetryGeneration] = useState(0)
  return (
    <div data-workspace-reference-search="">
      <WorkspaceAttachmentSearch
        key={retryGeneration}
        {...props}
        onRetry={() => {
          setRetryGeneration((generation) => generation + 1)
          requestAnimationFrame(() => props.inputRef.current?.focus())
        }}
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          props.onQueryChange()
        }}
        kind={kind}
        onKindChange={setKind}
      />
    </div>
  )
}
