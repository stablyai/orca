// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { chatTakesOrcaRuntimeSignIn, useAgentCopyOwnCommand } from './NativeChatInstallSlot'

const initialState = useAppStore.getState()

afterEach(() => useAppStore.setState(initialState, true))

function ownCommand(
  copyId: string | null,
  target: { kind: 'local' } | { kind: 'environment'; environmentId: string } = { kind: 'local' },
  agent = 'claude'
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only agentCopies.
  const settings = {
    agentCopies: [
      { id: 'claude.own', name: 'Own', agent: 'claude', command: '/opt/own/claude' },
      { id: 'claude.plain', name: 'Plain', agent: 'claude' }
    ]
  } as GlobalSettings
  useAppStore.setState({ settings })
  return renderHook(() => useAgentCopyOwnCommand(agent, copyId, target)).result.current
}

describe("a copy chat's install gate", () => {
  it('needs no Orca runtime for a local copy with its own Command', () => {
    expect(ownCommand('claude.own')).toBe(true)
  })

  it('still needs it for the agent itself, a copy without a Command, or another host', () => {
    expect(ownCommand(null)).toBe(false)
    expect(ownCommand('claude.plain')).toBe(false)
    expect(ownCommand('claude.own', { kind: 'environment', environmentId: 'paired' })).toBe(false)
    expect(ownCommand('claude.own', { kind: 'local' }, 'codex')).toBe(false)
  })
})

describe("Orca's Antigravity sign-in", () => {
  const observation = {
    kind: 'active' as const,
    subject: { target: { kind: 'local' as const }, runtimeId: null, agent: 'antigravity' },
    removable: true,
    snapshot: {
      kind: 'known' as const,
      state: {
        agent: 'antigravity',
        revision: 1,
        available: true,
        version: '1.5.13',
        installedVersion: '1.5.13',
        installedCurrent: true,
        source: 'managed' as const,
        operation: null
      }
    }
  }
  const signsIn = (ownCommand: boolean) =>
    chatTakesOrcaRuntimeSignIn({
      agent: 'antigravity',
      visible: true,
      hostProgram: false,
      ownCommand,
      slot: { kind: 'none' },
      observation
    })

  it("is asked of a chat on Orca's runtime, never of a copy with its own Command", () => {
    expect(signsIn(false)).toBe(true)
    expect(signsIn(true)).toBe(false)
  })
})
