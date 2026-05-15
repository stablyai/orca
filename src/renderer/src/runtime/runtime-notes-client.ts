import type { GlobalSettings } from '../../../shared/types'
import type {
  NoteAppendArgs,
  NoteCreateArgs,
  NoteDeleteArgs,
  NoteDeleteResult,
  NoteLink,
  NoteLinkArgs,
  NoteListArgs,
  NoteListResult,
  NoteMutationResult,
  NoteRenameArgs,
  NoteSaveArgs,
  NoteSearchArgs,
  NoteShowArgs,
  NoteShowResult,
  NotesPanelOpenState,
  NotesPanelStateArgs
} from '../../../shared/notes-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

type RuntimeNotesSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

function requireWorktreeId(worktreeId: string | null | undefined): string {
  if (!worktreeId?.trim()) {
    throw new Error('Project notes require an active worktree on remote runtime servers.')
  }
  return worktreeId
}

function noteTarget(settings: RuntimeNotesSettings): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(settings)
}

export async function listRuntimeProjectNotes(
  settings: RuntimeNotesSettings,
  args: NoteListArgs
): Promise<NoteListResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.list(args)
  }
  return callRuntimeRpc<NoteListResult>(
    target,
    'note.list',
    { worktree: requireWorktreeId(args.worktreeId), limit: args.limit },
    { timeoutMs: 15_000 }
  )
}

export async function showRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteShowArgs
): Promise<NoteShowResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.show(args)
  }
  return callRuntimeRpc<NoteShowResult>(
    target,
    'note.show',
    { worktree: requireWorktreeId(args.worktreeId), note: args.note },
    { timeoutMs: 15_000 }
  )
}

export async function createRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteCreateArgs
): Promise<NoteMutationResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.create(args)
  }
  return callRuntimeRpc<NoteMutationResult>(
    target,
    'note.create',
    {
      worktree: requireWorktreeId(args.worktreeId),
      title: args.title,
      bodyMarkdown: args.bodyMarkdown,
      makeActive: args.makeActive,
      createdBySessionId: args.createdBySessionId
    },
    { timeoutMs: 15_000 }
  )
}

export async function saveRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteSaveArgs
): Promise<NoteMutationResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.save(args)
  }
  return callRuntimeRpc<NoteMutationResult>(
    target,
    'note.save',
    {
      worktree: requireWorktreeId(args.worktreeId),
      note: args.note,
      title: args.title,
      bodyMarkdown: args.bodyMarkdown,
      revision: args.revision,
      makeActive: args.makeActive,
      updatedBySessionId: args.updatedBySessionId
    },
    { timeoutMs: 15_000 }
  )
}

export async function renameRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteRenameArgs
): Promise<NoteMutationResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.rename(args)
  }
  return callRuntimeRpc<NoteMutationResult>(
    target,
    'note.rename',
    {
      worktree: requireWorktreeId(args.worktreeId),
      note: args.note,
      title: args.title,
      updatedBySessionId: args.updatedBySessionId
    },
    { timeoutMs: 15_000 }
  )
}

export async function deleteRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteDeleteArgs
): Promise<NoteDeleteResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.delete(args)
  }
  return callRuntimeRpc<NoteDeleteResult>(
    target,
    'note.delete',
    { worktree: requireWorktreeId(args.worktreeId), note: args.note },
    { timeoutMs: 15_000 }
  )
}

export async function appendRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteAppendArgs
): Promise<NoteMutationResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.append(args)
  }
  return callRuntimeRpc<NoteMutationResult>(
    target,
    'note.append',
    {
      worktree: requireWorktreeId(args.worktreeId),
      note: args.note,
      bodyMarkdown: args.bodyMarkdown,
      makeActive: args.makeActive,
      updatedBySessionId: args.updatedBySessionId
    },
    { timeoutMs: 15_000 }
  )
}

export async function searchRuntimeProjectNotes(
  settings: RuntimeNotesSettings,
  args: NoteSearchArgs
): Promise<NoteListResult> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.search(args)
  }
  return callRuntimeRpc<NoteListResult>(
    target,
    'note.search',
    {
      worktree: requireWorktreeId(args.worktreeId),
      query: args.query,
      limit: args.limit
    },
    { timeoutMs: 15_000 }
  )
}

export async function linkRuntimeProjectNote(
  settings: RuntimeNotesSettings,
  args: NoteLinkArgs
): Promise<NoteLink> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.link(args)
  }
  return callRuntimeRpc<NoteLink>(
    target,
    'note.link',
    {
      worktree: requireWorktreeId(args.worktreeId),
      note: args.note,
      kind: args.kind
    },
    { timeoutMs: 15_000 }
  )
}

export async function resolveRuntimeNotesPanelState(
  settings: RuntimeNotesSettings,
  args: NotesPanelStateArgs
): Promise<NotesPanelOpenState> {
  const target = noteTarget(settings)
  if (target.kind === 'local') {
    return window.api.notes.panelState(args)
  }
  if (!args.projectId && !args.worktreeId) {
    return { state: 'noProject' }
  }
  return callRuntimeRpc<NotesPanelOpenState>(
    target,
    'note.panelState',
    { worktree: requireWorktreeId(args.worktreeId) },
    { timeoutMs: 15_000 }
  )
}
