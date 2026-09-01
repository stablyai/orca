// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CustomAgentEnvRowsEditor } from './CustomAgentEnvRowsEditor'
import { createEnvRow } from './custom-agent-editor-state'
import type { BuiltInTuiAgent } from '../../../../shared/types'
import type { UseCustomAgentEditor } from './use-custom-agent-editor'

function stubEditor(baseAgent: BuiltInTuiAgent = 'claude'): UseCustomAgentEditor {
  return {
    draft: { envRows: [createEnvRow()] },
    baseAgent,
    fieldErrors: [],
    envSizeBytes: 0,
    setEnvRows: vi.fn(),
    registerTemplateField: vi.fn()
  } as unknown as UseCustomAgentEditor
}

const MANAGED_ACCOUNT_COPY = /Explicit provider auth or home values here \(including CODEX_HOME\)/

afterEach(() => cleanup())

describe('CustomAgentEnvRowsEditor', () => {
  it('states that custom env overrides the base harness defaults', () => {
    // Precedence copy (F2): composeAgentLaunchEnv layers agentEnv after the
    // provider/base defaults, so this hint must reflect that custom wins.
    render(<CustomAgentEnvRowsEditor editor={stubEditor()} />)
    expect(
      screen.getByText("Variables set here override the base harness's default environment.")
    ).toBeTruthy()
  })

  it('adds the managed-account precedence copy naming CODEX_HOME for a Codex base', () => {
    // Plan §987: only managed-account bases inject a selected account, so the
    // auth/home-override line must appear there and name CODEX_HOME.
    render(<CustomAgentEnvRowsEditor editor={stubEditor('codex')} />)
    expect(screen.getByText(MANAGED_ACCOUNT_COPY)).toBeTruthy()
  })

  it('omits the managed-account precedence copy for a base with no managed account', () => {
    render(<CustomAgentEnvRowsEditor editor={stubEditor('aider')} />)
    expect(screen.queryByText(MANAGED_ACCOUNT_COPY)).toBeNull()
  })
})
