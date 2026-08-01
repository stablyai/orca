import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

let state: Record<string, unknown> = {}
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: Record<string, unknown>) => unknown) => selector(state)
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { AutomationRunContextPressure } from './AutomationRunContextPressure'

describe('AutomationRunContextPressure', () => {
  it('renders exact pressure for the run pane and stays honest for unknown panes', () => {
    state = {
      settings: { experimentalContextPressure: true },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': {
          state: 'working',
          prompt: 'scheduled task',
          agentType: 'claude',
          contextUsage: { usedTokens: 180_000, maxTokens: 200_000 }
        }
      }
    }
    const known = renderToStaticMarkup(<AutomationRunContextPressure paneKey="tab-1:leaf-1" />)
    expect(known).toContain('data-context-pressure="critical"')
    expect(known).toContain('180.0k of 200.0k tokens')
    expect(renderToStaticMarkup(<AutomationRunContextPressure paneKey="missing" />)).toBe('')
  })
})
