import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { setRendererUiLanguage } from '../../i18n/i18n'
import { DashboardAgentChildDisclosure } from './DashboardAgentChildDisclosure'

describe('child Agent disclosure', () => {
  it('localizes the action, count, and Agent label in Traditional Chinese', async () => {
    await setRendererUiLanguage('zh-TW')
    try {
      const show = renderToStaticMarkup(
        <DashboardAgentChildDisclosure
          childAgentCount={2}
          childAgentsExpanded={false}
          onToggleChildAgents={() => {}}
        />
      )
      const hide = renderToStaticMarkup(
        <DashboardAgentChildDisclosure
          childAgentCount={1}
          childAgentsExpanded
          onToggleChildAgents={() => {}}
        />
      )

      expect(show).toContain('aria-label="顯示 2 個子 Agent"')
      expect(hide).toContain('aria-label="隱藏 1 個子 Agent"')
    } finally {
      await setRendererUiLanguage('en')
    }
  })
})
