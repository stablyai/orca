export type NoteLinkKind = 'active' | 'referenced'

export type NoteRecord = {
  id: string
  projectId: string
  filePath: string
  relativePath: string
  title: string
  bodyMarkdown: string
  revision: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  createdBySessionId?: string | null
  updatedBySessionId?: string | null
}

export type NoteLink = {
  noteId: string
  projectId: string
  worktreeId: string
  kind: NoteLinkKind
  createdAt: string
}

export type NoteSummary = Omit<NoteRecord, 'bodyMarkdown'> & {
  preview: string
  linkKind: NoteLinkKind | null
}

export type NoteListResult = {
  notes: NoteSummary[]
  totalCount: number
  truncated: boolean
}

export type NoteShowResult = {
  note: NoteRecord
  linkKind: NoteLinkKind | null
}

export type NoteMutationResult = {
  note: NoteRecord
  linkKind: NoteLinkKind | null
}

export type NotesPanelOpenState =
  | { state: 'noProject' }
  | { state: 'emptyDraft'; projectId: string; worktreeId: string | null }
  | { state: 'pickerRequired'; projectId: string; worktreeId: string | null; notes: NoteSummary[] }
  | { state: 'active'; projectId: string; worktreeId: string | null; note: NoteRecord }

export type NoteListArgs = {
  projectId: string
  worktreeId?: string | null
  limit?: number
}

export type NoteShowArgs = {
  projectId: string
  worktreeId?: string | null
  note: string
}

export type NoteCreateArgs = {
  projectId: string
  worktreeId?: string | null
  title: string
  bodyMarkdown?: string
  makeActive?: boolean
  createdBySessionId?: string | null
}

export type NoteSaveArgs = {
  projectId: string
  worktreeId?: string | null
  note: string
  title?: string
  bodyMarkdown: string
  revision?: number
  makeActive?: boolean
  updatedBySessionId?: string | null
}

export type NoteRenameArgs = {
  projectId: string
  worktreeId?: string | null
  note: string
  title: string
  updatedBySessionId?: string | null
}

export type NoteDeleteArgs = {
  projectId: string
  worktreeId?: string | null
  note: string
}

export type NoteDeleteResult = {
  noteId: string
  projectId: string
}

export type NoteAppendArgs = {
  projectId: string
  worktreeId?: string | null
  note: string
  bodyMarkdown: string
  makeActive?: boolean
  updatedBySessionId?: string | null
}

export type NoteSearchArgs = {
  projectId: string
  worktreeId?: string | null
  query: string
  limit?: number
}

export type NoteLinkArgs = {
  projectId: string
  worktreeId: string
  note: string
  kind: NoteLinkKind
}

export type NotesPanelStateArgs = {
  projectId?: string | null
  worktreeId?: string | null
}
