import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'

export type ClaudeAccountPromptAnswer =
  | { kind: 'start'; accountId: string; remember: boolean }
  | { kind: 'cancelled' }

export type ClaudeAccountPromptRequest = {
  projectName: string
  accounts: ClaudeManagedAccountSummary[]
  activeAccountId: string | null
  resolve: (answer: ClaudeAccountPromptAnswer) => void
}

const requests: ClaudeAccountPromptRequest[] = []
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function requestClaudeAccountPrompt(
  request: Omit<ClaudeAccountPromptRequest, 'resolve'>
): Promise<ClaudeAccountPromptAnswer> {
  return new Promise((resolve) => {
    requests.push({ ...request, resolve })
    notifyListeners()
  })
}

export function answerClaudeAccountPrompt(answer: ClaudeAccountPromptAnswer): void {
  const request = requests.shift()
  if (!request) {
    return
  }
  request.resolve(answer)
  notifyListeners()
}

export function getClaudeAccountPromptRequest(): ClaudeAccountPromptRequest | null {
  return requests[0] ?? null
}

export function subscribeClaudeAccountPrompt(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetClaudeAccountPromptForTests(): void {
  for (const request of requests.splice(0)) {
    request.resolve({ kind: 'cancelled' })
  }
  notifyListeners()
}
