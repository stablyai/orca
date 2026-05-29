import { describe, expect, it } from 'vitest'

import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'
import { AGENT_CATALOG } from './agent-catalog'

describe('AGENT_CATALOG', () => {
  it('stays in sync with the default TUI agent selection order', () => {
    expect(AGENT_CATALOG.map((agent) => agent.id)).toEqual(TUI_AGENT_AUTO_PICK_ORDER)
  })
})
