import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../src/shared/agent-session-optional-model-capability'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../src/shared/remote-runtime-client-capabilities'
import { resolveBaselineReleaseRef } from './release-checkout'
import { callBuild } from './structured-agent-session-surface-execution'
import { installableHost, structuredHostStub } from './structured-agent-session-host-fixture'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild
} from './versioned-agent-session-wire'

let current: AgentSessionWireBuild
let baseline: AgentSessionWireBuild
const SESSION = 'model-options-session'

beforeAll(async () => {
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  baseline = await loadAgentSessionWireBuild(resolveBaselineReleaseRef())
}, 180_000)

afterEach(async () => {
  await current.installStructuredHost(null)
  if (baseline.methodNames.includes('agentSession.options')) {
    await baseline.installStructuredHost(null)
  }
})

describe('selected model reports across released client and host versions', () => {
  it('refuses an absent model only for an older client against the new host', async () => {
    const host = structuredHostStub(SESSION, 'folder-options')
    const report = { models: [], current: { effort: 'off' } }
    host.readOptions.mockResolvedValue(report)
    await current.installStructuredHost(installableHost(host))
    const legacy = [
      ...baseline.capabilities.filter(
        (value) => value !== AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
      ),
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ]
    expect(
      await callBuild(
        current,
        'agentSession.options',
        { sessionId: SESSION },
        {
          clientKind: 'runtime',
          clientCapabilities: legacy
        }
      )
    ).toMatchObject([{ ok: false, error: { message: 'structured_agent_session_unsupported' } }])
    expect(
      await callBuild(
        current,
        'agentSession.options',
        { sessionId: SESSION },
        {
          clientKind: 'runtime',
          clientCapabilities: remoteRuntimeClientCapabilities(
            ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
          )
        }
      )
    ).toMatchObject([{ ok: true, result: report }])
    host.readOptions.mockResolvedValue({ models: [], current: { model: 'reported-model' } })
    expect(
      await callBuild(
        current,
        'agentSession.options',
        { sessionId: SESSION },
        {
          clientKind: 'runtime',
          clientCapabilities: legacy
        }
      )
    ).toMatchObject([{ ok: true, result: { current: { model: 'reported-model' } } }])
  })

  it('lets a new desktop client read existing model reports from the released host', async () => {
    const client = {
      clientKind: 'runtime' as const,
      clientCapabilities: remoteRuntimeClientCapabilities(
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
    }
    if (!baseline.methodNames.includes('agentSession.options')) {
      expect(
        await callBuild(baseline, 'agentSession.options', { sessionId: SESSION }, client)
      ).toMatchObject([{ ok: false, error: { code: 'method_not_found' } }])
      return
    }
    const host = structuredHostStub(SESSION, 'folder-options')
    const report = { models: [], current: { model: 'released-model', effort: 'off' } }
    host.readOptions.mockResolvedValue(report)
    await baseline.installStructuredHost(installableHost(host))
    expect(
      await callBuild(baseline, 'agentSession.options', { sessionId: SESSION }, client)
    ).toMatchObject([{ ok: true, result: report }])
  })
})
