import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import AgentCombobox from '../../../src/renderer/src/components/agent/AgentCombobox'
import { getAgentCatalog } from '../../../src/renderer/src/lib/agent-catalog'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import './fixture.css'

const baseline = new URLSearchParams(window.location.search).get('baseline') === '1'

const agents = getAgentCatalog().map((agent) =>
  baseline && agent.id === 'omp' ? { ...agent, searchAliases: [] } : agent
)

function App() {
  const [selected, setSelected] = useState<TuiAgent | null>(null)

  return (
    <main className="p-6 bg-background text-foreground space-y-4">
      <h1>Agent picker</h1>
      <AgentCombobox
        agents={agents}
        value={selected}
        onValueChange={setSelected}
        allowBlankTerminal={false}
      />
      <p>Selected agent: {selected ?? 'none'}</p>
    </main>
  )
}

const root = document.getElementById('root')

if (root) {
  createRoot(root).render(<App />)
}
