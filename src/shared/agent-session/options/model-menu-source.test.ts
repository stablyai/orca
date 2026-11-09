import { expect, it } from 'vitest'
import { modelMenuUsesHostCatalog } from './model-menu-source'

it('uses the route fallback for WSL, SSH, unregistered agents and unrepresentable commands', () => {
  const host = ['native-only']
  const fallback = ['guest-only']
  const base = { nativeRuntime: true, registered: true, paired: false }
  for (const route of [
    { ...base, nativeRuntime: false },
    { ...base, registered: false },
    { ...base, commandOverride: 'CODEX_HOME=/other codex' },
    { ...base, commandOverride: 'codex | wrapper' },
    {
      ...base,
      paired: true,
      commandOverride: '/client/codex',
      serverCommandOverride: '/server/codex'
    }
  ]) {
    expect(modelMenuUsesHostCatalog(route) ? host : fallback).toEqual(['guest-only'])
  }
  expect(modelMenuUsesHostCatalog(base)).toBe(true)
  expect(modelMenuUsesHostCatalog({ ...base, commandOverride: '/opt/codex --profile work' })).toBe(
    true
  )
  expect(
    modelMenuUsesHostCatalog({
      ...base,
      paired: true,
      commandOverride: '/opt/codex --profile work',
      serverCommandOverride: '/opt/codex --profile work'
    })
  ).toBe(true)
})
