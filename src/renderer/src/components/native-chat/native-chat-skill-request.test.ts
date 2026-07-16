import { describe, expect, it, vi } from 'vitest'
import { createNativeChatSkillRequest } from './native-chat-skill-request'
import type { DiscoveredSkill } from '../../../../shared/skills'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function skill(name: string): DiscoveredSkill {
  return {
    id: name,
    name,
    description: null,
    providers: ['codex'],
    sourceKind: 'home',
    sourceLabel: 'Codex',
    rootPath: '/skills',
    directoryPath: `/skills/${name}`,
    skillFilePath: `/skills/${name}/SKILL.md`,
    installed: true,
    fileCount: 1,
    updatedAt: null
  }
}

describe('createNativeChatSkillRequest', () => {
  it('applies only the newest response when invalidation races an older list', async () => {
    const first = deferred<DiscoveredSkill[]>()
    const second = deferred<DiscoveredSkill[]>()
    const apply = vi.fn()
    const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const request = createNativeChatSkillRequest({ cwd: '/repo', list, apply })
    request.refresh()
    request.refresh(true)
    second.resolve([skill('installed')])
    await second.promise
    first.resolve([skill('stale')])
    await first.promise
    expect(list).toHaveBeenNthCalledWith(2, '/repo', true)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith([expect.objectContaining({ name: 'installed' })])
  })

  it('drops a response after cwd or agent teardown cancels the request', async () => {
    const pending = deferred<DiscoveredSkill[]>()
    const apply = vi.fn()
    const request = createNativeChatSkillRequest({
      cwd: '/old-cwd',
      list: () => pending.promise,
      apply
    })
    request.refresh()
    request.cancel()
    pending.resolve([skill('wrong-cwd')])
    await pending.promise
    expect(apply).not.toHaveBeenCalled()
  })
})
