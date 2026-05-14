import { useAppStore } from '@/store'
import { NOTES_ACTIVE_CHANGED_EVENT } from '@/lib/notes-events'

export function getProjectNotesEntityId(projectId: string, noteId?: string): string {
  if (noteId) {
    return `notes:${projectId}:note:${noteId}`
  }
  return `notes:${projectId}:new:${globalThis.crypto.randomUUID()}`
}

export function getProjectNoteIdFromEntityId(entityId: string): string | null {
  const [, , kind, noteId] = entityId.split(':')
  return kind === 'note' && noteId ? noteId : null
}

export function isNewProjectNoteEntityId(entityId: string): boolean {
  const [, , kind] = entityId.split(':')
  return kind === 'new'
}

export async function openProjectNotesTab(worktreeId: string, noteId?: string): Promise<void> {
  const state = useAppStore.getState()
  const targetGroupId =
    state.activeGroupIdByWorktree[worktreeId] ?? (state.groupsByWorktree[worktreeId] ?? [])[0]?.id
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((candidate) => candidate.id === worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === worktree?.repoId)
  const projectId = repo?.id ?? worktree?.repoId ?? null

  if (noteId && projectId) {
    await window.api.notes.link({ projectId, worktreeId, note: noteId, kind: 'active' })
  }

  let label = 'Project Notes'
  if (noteId && projectId) {
    try {
      const result = await window.api.notes.show({ projectId, worktreeId, note: noteId })
      label = result.note.title
    } catch {
      label = 'Project Notes'
    }
  }

  state.setActiveView('terminal')

  const tab = state.createUnifiedTab(worktreeId, 'notes', {
    targetGroupId,
    label,
    entityId: getProjectNotesEntityId(projectId ?? worktree?.repoId ?? worktreeId, noteId)
  })
  state.focusGroup(worktreeId, tab.groupId)
  state.activateTab(tab.id)
  state.setActiveTabType('notes')
  if (noteId) {
    notifyProjectNotesSelectionChanged()
  }
}

export function notifyProjectNotesSelectionChanged(): void {
  window.dispatchEvent(new CustomEvent(NOTES_ACTIVE_CHANGED_EVENT))
}
