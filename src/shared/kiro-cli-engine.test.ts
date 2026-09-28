import { describe, expect, it } from 'vitest'
import {
  isKiroUnsupportedEngineFlagOutput,
  isKiroV3EngineOutput,
  kiroAgentEngineArgs,
  KIRO_USAGE_ENGINE
} from './kiro-cli-engine'

describe('kiroAgentEngineArgs', () => {
  it('names the engine explicitly rather than relying on the CLI default', () => {
    expect(kiroAgentEngineArgs(KIRO_USAGE_ENGINE)).toEqual(['--agent-engine', 'v2'])
  })
})

describe('isKiroUnsupportedEngineFlagOutput', () => {
  it('recognises the clap rejection a pre-v3 CLI emits', () => {
    expect(
      isKiroUnsupportedEngineFlagOutput(
        "error: unexpected argument '--agent-engine' found\n\nUsage: kiro-cli-chat chat [INPUT]\n"
      )
    ).toBe(true)
  })

  it('ignores an argument error about some other flag', () => {
    expect(isKiroUnsupportedEngineFlagOutput("error: unexpected argument '--tui' found")).toBe(
      false
    )
  })

  it('ignores ordinary output that merely mentions the flag', () => {
    expect(isKiroUnsupportedEngineFlagOutput('running with --agent-engine v2')).toBe(false)
  })
})

describe('isKiroV3EngineOutput', () => {
  it('detects the KAS startup banner', () => {
    expect(
      isKiroV3EngineOutput('[INFO] kas.server.starting {"product":"KAS (Kiro Agent Server)"}')
    ).toBe(true)
  })

  it('does not fire on a v2 usage meter', () => {
    expect(
      isKiroV3EngineOutput('Estimated Usage | resets on 2026-10-01 | KIRO PRO\nCredits (1 of 10)')
    ).toBe(false)
  })
})
