import { expect, it } from 'vitest'
import { createConversationWorkspaceMatcher } from './conversation-workspace-matcher'

it('matches the most specific folder within its authenticated host and distro', () => {
  const rows = [
    { id: 'ubuntu', path: '//wsl.localhost/Ubuntu/home/me/project', hostId: 'local' as const },
    { id: 'debian', path: '//wsl.localhost/Debian/home/me/project', hostId: 'local' as const },
    { id: 'nested', path: '//wsl.localhost/Ubuntu/home/me/project/docs', hostId: 'local' as const },
    { id: 'remote', path: '/home/me/project', hostId: 'runtime:server' as const }
  ]
  const match = createConversationWorkspaceMatcher(rows)
  const session = {
    cwd: '/home/me/project/docs/subfolder',
    filePath: '//wsl.localhost/Ubuntu/home/me/.codex/chat.jsonl',
    executionHostId: 'local' as const
  }
  expect(match(session)?.id).toBe('nested')
  expect(match({ ...session, filePath: '/home/me/.codex/chat.jsonl' })).toBeNull()
  expect(match({ ...session, executionHostId: 'runtime:server' })?.id).toBe('remote')
})

it('keeps structured workspace ownership exact and refuses ambiguous folder twins', () => {
  const rows = [
    { id: 'one', path: '/notes', hostId: 'local' as const },
    { id: 'two', path: '/notes', hostId: 'local' as const }
  ]
  const match = createConversationWorkspaceMatcher(rows)
  const session = { cwd: '/notes/child', executionHostId: 'local' as const }
  expect(match(session)).toBeNull()
  expect(match({ ...session, structuredSession: { workspaceId: 'two' } })).toBe(rows[1])
  expect(match({ ...session, structuredSession: { workspaceId: 'missing' } })).toBeNull()
})
