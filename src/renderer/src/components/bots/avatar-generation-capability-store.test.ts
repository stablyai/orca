// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AvatarGenerationApi,
  AvatarGenerationCapability
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import * as store from './avatar-generation-capability-store'

type Answer = { resolve: (found: AvatarGenerationCapability) => void }

const READY: AvatarGenerationCapability = { agents: [{ agent: 'codex', status: 'ready' }] }

// Each probe main is asked for waits until the test answers it.
function stubMain(): { calls: Parameters<AvatarGenerationApi['capability']>[]; answers: Answer[] } {
  const calls: Parameters<AvatarGenerationApi['capability']>[] = []
  const answers: Answer[] = []
  vi.stubGlobal('api', {
    avatarGeneration: {
      capability: (...args: Parameters<AvatarGenerationApi['capability']>) => {
        calls.push(args)
        return new Promise<AvatarGenerationCapability>((resolve) => answers.push({ resolve }))
      }
    }
  })
  return { calls, answers }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// The store is app-wide: each test starts from launch, whatever ran before it.
beforeEach(() => {
  store.resetAvatarCapabilityForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('never lets a probe started before a run outcome overwrite it', async () => {
  const main = stubMain()
  store.refreshAvatarCapability()
  main.answers[0]?.resolve(READY)
  await settled()

  store.refreshAvatarCapability()
  store.setAvatarAgentStatus('codex', 'signed-out')
  main.answers[1]?.resolve(READY)
  await settled()

  expect(store.readAvatarCapability()).toEqual([{ agent: 'codex', status: 'signed-out' }])
})

it('answers Check again only with a fresh probe, once, even behind a quiet one', async () => {
  const main = stubMain()
  store.refreshAvatarCapability()
  store.refreshAvatarCapability({ fresh: true })
  store.refreshAvatarCapability({ fresh: true })

  // The quiet probe's possibly cached answer is dropped, and Check again is still checking.
  main.answers[0]?.resolve({ agents: [] })
  await settled()
  expect(store.readAvatarCapability()).toBeNull()
  expect(store.readAvatarCapabilityChecking()).toBe(true)

  store.refreshAvatarCapability({ fresh: true })
  main.answers[1]?.resolve(READY)
  await settled()

  expect(main.calls).toEqual([[undefined], [{ fresh: true }]])
  expect(store.readAvatarCapability()).toEqual(READY.agents)
  expect(store.readAvatarCapabilityChecking()).toBe(false)
})
