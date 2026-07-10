export function resolveGitHubBodyDraft(draft: string, body: string, editing: boolean): string {
  return editing ? draft : body
}

export function shouldSyncGitHubBodyDraft(draft: string, body: string, editing: boolean): boolean {
  return !editing && draft !== body
}
