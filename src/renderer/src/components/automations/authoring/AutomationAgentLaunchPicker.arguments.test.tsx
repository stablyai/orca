// @vitest-environment happy-dom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import '../../settings/__fixtures__/settings-persistence-test-fixture'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog/agent-catalog'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { AutomationAgentLaunchPicker } from './AutomationAgentLaunchPicker'
import type { AutomationDraft } from './AutomationEditorDialog'

const DRAFT: AutomationDraft = {
  name: 'Nightly',
  prompt: 'Triage',
  agentId: 'claude',
  surface: 'terminal',
  extraAgentArgs: '--add-dir /docs',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: 'main',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  savedSchedule: null,
  missedRunGraceMinutes: '',
  scheduleWarning: null
}

it('keeps saved extra arguments supplemental, so host default arguments stay inherited', () => {
  let latest = DRAFT
  function Form() {
    const [draft, setDraft] = useState(DRAFT)
    latest = draft
    return (
      <TooltipProvider>
        <AutomationAgentLaunchPicker
          draft={draft}
          workspace={{ kind: 'git-worktree', repoId: 'repo-1' }}
          authority={{ kind: 'desktop' }}
          visibleAgents={AGENT_CATALOG.filter((agent) => agent.id === 'claude')}
          settings={getDefaultSettings('/tmp')}
          surface="terminal"
          chatSupported
          onDraftChange={setDraft}
        />
      </TooltipProvider>
    )
  }
  render(<Form />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Extra agent arguments' }), {
    target: { value: '--add-dir /docs --add-dir /more' }
  })
  expect(latest.agentArgs).toBeUndefined()
  expect(latest.extraAgentArgs).toBe('--add-dir /docs --add-dir /more')
  expect(latest.launchArgumentsInput).toEqual({
    kind: 'supplemental',
    value: '--add-dir /docs --add-dir /more'
  })
})
