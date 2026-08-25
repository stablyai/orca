// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationAgentOptionsFields } from './AutomationAgentOptionsFields'

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <select>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const draft: AutomationDraft = {
  name: '',
  prompt: '',
  agentId: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  projectId: '',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: '',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '60',
  preset: 'weekdays',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  missedRunGraceMinutes: '720',
  scheduleWarning: null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AutomationAgentOptionsFields', () => {
  it('renders the agent model catalog and model-specific effort choices', () => {
    act(() => {
      root.render(
        <AutomationAgentOptionsFields
          draft={draft}
          pickerTriggerClassName=""
          onDraftChange={() => undefined}
        />
      )
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Agent default')
    expect(text).toContain('GPT-5.6 Sol')
    expect(text).toContain('Model default')
    expect(text).toContain('High')
    expect(text).toContain('Ultra')
  })
})
