import { describe, expect, it } from 'vitest'
import { PluginSyntaxSlotPool } from './plugin-syntax-slot-pool'

function pool(limit?: number) {
  const registered: string[] = []
  const live = new Set<string>()
  const released: string[] = []
  const instance = new PluginSyntaxSlotPool({
    limit,
    register: (languageId) => registered.push(languageId),
    create: (languageId, key) => {
      const id = `${languageId}:${key}`
      live.add(id)
      return {
        dispose: () => {
          live.delete(id)
        },
        releaseModels: () => {
          released.push(id)
        }
      }
    }
  })
  return { instance, registered, live, released }
}

describe('PluginSyntaxSlotPool', () => {
  it('never runs out when 600 languages are opened and closed one after another', () => {
    const { instance, registered, live } = pool()
    for (let index = 0; index < 600; index += 1) {
      const lease = instance.acquire(`plugin:samples.lang/${index}@r1`)
      expect(lease).not.toBeNull()
      lease?.release()
    }
    // Idle languages stay bound for a quick reopen, but only a bounded number of them.
    expect(registered.length).toBeLessThanOrEqual(17)
    expect(live.size).toBeLessThanOrEqual(16)
  })

  it('shares a slot between files of the same language and revision', () => {
    const { instance, registered } = pool()
    const first = instance.acquire('plugin:a/x@r1')
    const second = instance.acquire('plugin:a/x@r1')
    const updated = instance.acquire('plugin:a/x@r2')
    expect(second?.languageId).toBe(first?.languageId)
    expect(updated?.languageId).not.toBe(first?.languageId)
    expect(registered).toHaveLength(2)
  })

  it('evicts the least recently used idle language, and only falls back when all are open', () => {
    const { instance, live } = pool(2)
    const a = instance.acquire('a@1')
    const b = instance.acquire('b@1')
    a?.release()
    b?.release()
    // `a` is older, so it is evicted first.
    const c = instance.acquire('c@1')
    expect(c?.languageId).toBe(a?.languageId)
    expect([...live].some((id) => id.endsWith(':a@1'))).toBe(false)
    const d = instance.acquire('d@1')
    expect(d?.languageId).toBe(b?.languageId)
    expect(instance.acquire('e@1')).toBeNull()
    c?.release()
    expect(instance.acquire('e@1')?.languageId).toBe(c?.languageId)
  })

  it('ignores a second release of the same lease', () => {
    const { instance } = pool(1)
    const first = instance.acquire('a@1')
    const second = instance.acquire('a@1')
    first?.release()
    first?.release()
    expect(instance.acquire('b@1')).toBeNull()
    second?.release()
  })

  it('moves models off a language once no editor uses it', () => {
    const { instance, released } = pool()
    const first = instance.acquire('a@1')
    const second = instance.acquire('a@1')
    first?.release()
    expect(released).toEqual([])
    second?.release()
    expect(released).toEqual([`${second?.languageId}:a@1`])
  })
})
