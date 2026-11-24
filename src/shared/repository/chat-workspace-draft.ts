import { createNonSecureContextUuid } from '../identifiers/non-secure-context-uuid'

export function createChatWorkspaceDraft(now = new Date()): { name: string; date: string } {
  return {
    name: `${now.toISOString().slice(0, 10)}-${createNonSecureContextUuid()}`,
    date: `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  }
}
