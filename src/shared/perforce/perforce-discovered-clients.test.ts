import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickClientForFolder } from './perforce-discovered-clients'

const base = resolve('/p4')
const record = (client: string, root: string, host: string) => ({ client, Root: root, Host: host })

describe('pickClientForFolder', () => {
  it('picks the deepest root on this host and refuses to guess between clients sharing it', () => {
    const clients = [
      record('outer', base, 'desk'),
      record('inner', join(base, 'game'), 'DESK'),
      record('elsewhere', join(base, 'game', 'src'), 'laptop'),
      record('sibling', join(base, 'game-old'), 'desk')
    ]
    expect(pickClientForFolder(clients, join(base, 'game', 'src'), 'desk')).toEqual({
      kind: 'found',
      client: 'inner',
      root: join(base, 'game')
    })
    expect(pickClientForFolder(clients, resolve('/other'), 'desk')).toEqual({ kind: 'none' })

    const shared = [...clients, record('anyhost', join(base, 'game'), '')]
    expect(pickClientForFolder(shared, join(base, 'game'), 'desk')).toEqual({
      kind: 'ambiguous',
      clients: ['inner', 'anyhost']
    })
  })
})
