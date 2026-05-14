import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NotificationStep } from './NotificationStep'

describe('NotificationStep', () => {
  it('renders the feature setup checklist in the notification step', () => {
    const html = renderToStaticMarkup(
      <NotificationStep
        value={{
          agentTaskComplete: true,
          terminalBell: true,
          notifyWhenFocused: true
        }}
        onChange={vi.fn()}
        featureSetup={{
          browserUse: true,
          computerUse: true,
          orchestration: true
        }}
        onFeatureSetupChange={vi.fn()}
        featureSetupCommand={null}
        featureSetupCommandSelection={null}
      />
    )

    expect(html).toContain('Set up agent features')
    expect(html).toContain('Agent Browser Use')
    expect(html).toContain('Computer Use')
    expect(html).toContain('Agent Orchestration')
    expect(html).toContain('role="checkbox"')
  })
})
