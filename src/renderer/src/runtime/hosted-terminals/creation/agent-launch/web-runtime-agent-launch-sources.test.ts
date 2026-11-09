// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import { host, call, launch, params } from './web-runtime-agent-launch-options.test-fixture'
import { sourceEntry } from '@/components/agent/agent-launch-picker-sources.test-fixture'
import { applyAgentPickerEdit } from '../../../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import {
  agentPickerDraft,
  agentPickerFreshLaunchInputs
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker'

beforeEach(() => {
  call.mockClear()
})

it.each(['current', 'legacy-authority', 'legacy-choices'] as const)(
  'sends an effort-only default replaced by a CLI model through the %s paired carrier',
  async (carrier) => {
    host.capabilities = [
      'agent-session.host-authority.v1',
      ...(carrier === 'current' ? ['agent-session.create-options.v1'] : []),
      ...(carrier === 'legacy-choices' ? ['settings.agent-launch.choices.v1'] : [])
    ]
    const entry = { ...sourceEntry(), terminal: { options: { effort: 'high' } } }
    const draft = applyAgentPickerEdit(entry, agentPickerDraft(entry, 'terminal'), {
      kind: 'choice',
      patch: { model: 'gemini-3.8-flash-low' }
    })
    const inputs = agentPickerFreshLaunchInputs(
      draft,
      { surface: 'terminal', executionHostId: 'runtime:paired' },
      entry
    )
    await launch({ agent: 'antigravity', ...inputs })
    const request = params('terminal.createAgentSession')
    if (carrier === 'current') {
      expect(request.sessionOptions).toEqual({ model: 'gemini-3.8-flash-low' })
      expect(request).not.toHaveProperty('agentArgs')
    } else {
      expect(request.launchPreferences).toEqual({ model: 'gemini-3.8-flash-low' })
      expect(request).not.toHaveProperty('agentArgs')
      expect(request).not.toHaveProperty('sessionOptions')
    }
  }
)
