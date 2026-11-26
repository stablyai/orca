import { expect, it } from 'vitest'
import { claudeSwitcherScope } from './claude-switcher-scope'

const chatAction = {
  target: { kind: 'environment', environmentId: 'wsl-ubuntu' } as const,
  canSwitch: async () => true
}

it("lists a WSL host chat's accounts on this desktop for its distro", () => {
  const owner = { target: { kind: 'local' } as const, wslHostDistro: 'Ubuntu' }
  expect(claudeSwitcherScope(chatAction, owner)).toEqual({
    runtimeTarget: { kind: 'local' },
    wslHostDistro: 'Ubuntu',
    chatOnHost: false
  })
})

it("keeps any other chat on its own host's accounts", () => {
  const owner = { target: chatAction.target, wslHostDistro: null }
  expect(claudeSwitcherScope(chatAction, owner)).toEqual({
    runtimeTarget: chatAction.target,
    wslHostDistro: null,
    chatOnHost: true
  })
})
