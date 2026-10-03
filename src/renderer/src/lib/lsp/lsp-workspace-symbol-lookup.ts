import { getLspClient, releaseLspClient, retainLspClient } from './lsp-session-opener'
import {
  splitSymbolToken,
  toWorkspaceSymbolCandidates,
  type WorkspaceSymbolCandidate
} from './lsp-workspace-symbol-ranking'

// Why one language per server family: typescript and javascript share the same session.
const LOOKUP_LANGUAGES = ['typescript', 'ruby'] as const

export async function lookupWorkspaceSymbol(
  worktreeId: string,
  token: string
): Promise<WorkspaceSymbolCandidate[]> {
  const { name } = splitSymbolToken(token)
  const results = await Promise.all(
    LOOKUP_LANGUAGES.map(async (languageId) => {
      // Why: the lease keeps a doc-less lookup from pinning the session open afterwards.
      retainLspClient(worktreeId, languageId)
      try {
        const client = await getLspClient(worktreeId, languageId)
        const raw = client
          ? await client.request('workspace/symbol', { query: name }).catch(() => null)
          : null
        return toWorkspaceSymbolCandidates(raw)
      } finally {
        releaseLspClient(worktreeId, languageId)
      }
    })
  )
  return results.flat()
}
