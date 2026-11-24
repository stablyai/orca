import { describe, expect, it } from 'vitest'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { getTaskSourceCacheScope } from '../../../../../shared/work-items/task-source-context'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { botItemLinkRows } from '../../../../../shared/bots/bot-item-link-rows'
import { selectBotItemLinearRead } from './bot-item-linear-read'

const URL_A = 'https://linear.app/acme/issue/ENG-7/share-dialog'

function issue(over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'uuid-a',
    workspaceId: 'ws-acme',
    identifier: 'ENG-7',
    title: 'Share dialog',
    url: 'https://linear.app/acme/issue/ENG-7/share-dialog',
    state: { name: 'In Progress', type: 'started', color: '#999999' },
    team: { id: 't1', name: 'Eng', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-11-14T00:00:00Z',
    ...over
  }
}

const entry = (data: LinearIssue | null, fetchedAt = 1) => ({ data, fetchedAt })

const BOT_HOST: ExecutionHostId = 'runtime:studio'
const OTHER_HOST: ExecutionHostId = 'local'

/** The key `fetchLinearIssue` publishes for the app's own (default-scope) read: no source prefix. */
function producerKey(workspaceId: string | undefined, id: string): string {
  return `${workspaceId ?? 'selected'}::${id}`
}

/** The key it publishes for a project's Linear source on `hostId`. */
function sourceKey(hostId: ExecutionHostId, workspaceId: string, id: string): string {
  const scope = getTaskSourceCacheScope({ provider: 'linear', hostId, projectId: 'project-1' })
  return `${scope}::${workspaceId}::${id}`
}

const read = (cache: Record<string, ReturnType<typeof entry>>, url = URL_A) =>
  selectBotItemLinearRead(cache, 'ENG-7', url, BOT_HOST)

describe('selectBotItemLinearRead', () => {
  it('reads the identifier the link row derives from its URL', () => {
    const [row] = botItemLinkRows([{ kind: 'url', ref: URL_A }])
    expect(row.kind === 'web' && row.linear).toBe('ENG-7')
  })

  it('uses reads published under the real producer keys, by identifier or UUID', () => {
    const want = { title: 'Share dialog', state: 'In Progress' }
    expect(read({ [producerKey(undefined, 'ENG-7')]: entry(issue()) })).toEqual(want)
    expect(read({ [producerKey('ws-acme', 'ENG-7')]: entry(issue()) })).toEqual(want)
    expect(read({ [producerKey('ws-acme', 'uuid-a')]: entry(issue()) })).toEqual(want)
    expect(read({ 'ENG-7': entry(issue()) })).toEqual(want)
  })

  it('picks the organization in the link when two organizations share the identifier', () => {
    const other = issue({
      id: 'uuid-b',
      workspaceId: 'ws-globex',
      title: 'Globex billing',
      url: 'https://linear.app/globex/issue/ENG-7/billing'
    })
    const cache = {
      [producerKey('ws-acme', 'ENG-7')]: entry(issue()),
      [producerKey('ws-globex', 'ENG-7')]: entry(other)
    }
    expect(read(cache)?.title).toBe('Share dialog')
    expect(read(cache, 'https://linear.app/globex/issue/ENG-7')?.title).toBe('Globex billing')
    expect(read(cache, 'https://linear.app/initech/issue/ENG-7')).toBeNull()
  })

  it("reads a project source on the bot's own host, never one on another host", () => {
    expect(read({ [sourceKey(BOT_HOST, 'ws-acme', 'ENG-7')]: entry(issue()) })?.title).toBe(
      'Share dialog'
    )
    expect(read({ [sourceKey(BOT_HOST, 'ws-acme', 'uuid-a')]: entry(issue()) })?.title).toBe(
      'Share dialog'
    )
    expect(read({ [sourceKey(OTHER_HOST, 'ws-acme', 'ENG-7')]: entry(issue()) })).toBeNull()
  })

  it('leaves the identifier alone for another link host, account or issue', () => {
    expect(
      read({
        'selected::ENG-7': entry(issue({ url: 'https://linear.evil.test/acme/issue/ENG-7' }))
      })
    ).toBeNull()
    expect(read({ 'ws-globex::ENG-7': entry(issue()) })).toBeNull()
    expect(read({ 'selected::ENG-8': entry(issue()) })).toBeNull()
  })

  it('shows nothing when two different issues match or a newer read found none', () => {
    const twin = issue({ id: 'uuid-twin', title: 'Impostor' })
    expect(read({ 'selected::ENG-7': entry(issue()), 'ws-acme::ENG-7': entry(twin, 2) })).toBeNull()
    expect(
      read({ 'ws-acme::ENG-7': entry(issue(), 1), 'selected::ENG-7': entry(null, 2) })
    ).toBeNull()
    expect(
      read({ 'ws-acme::ENG-7': entry(issue(), 3), 'selected::ENG-7': entry(null, 2) })
    ).toEqual({ title: 'Share dialog', state: 'In Progress' })
  })

  it('takes the newest of several reads of the same issue', () => {
    const newer = issue({ state: { name: 'Done', type: 'completed', color: '#999999' } })
    expect(
      read({ 'selected::ENG-7': entry(issue(), 1), 'ws-acme::uuid-a': entry(newer, 2) })?.state
    ).toBe('Done')
  })
})
