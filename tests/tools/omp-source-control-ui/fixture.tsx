import React from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultSettings } from '../../../src/shared/constants'
import type { GlobalSettings } from '../../../src/shared/global-settings-types'
import { CommitMessageAiPane } from '../../../src/renderer/src/components/settings/CommitMessageAiPane'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { useAppStore } from '../../../src/renderer/src/store'
import './fixture.css'

const settings = getDefaultSettings('/disposable-omp-ui-home')
settings.sourceControlAi = {
  enabled: true,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  instructionsByOperation: {},
  actions: {},
  customAgentCommand: ''
}
const updateSettings = async (patch: Partial<GlobalSettings>): Promise<void> => {
  const current = useAppStore.getState().settings
  if (!current) {
    throw new Error('Settings fixture not initialized')
  }
  useAppStore.setState({ settings: { ...current, ...patch } })
}
useAppStore.setState({ settings, repos: [], settingsSearchQuery: '', updateSettings })

function Fixture(): React.JSX.Element {
  const current = useAppStore((state) => state.settings)
  if (!current) {
    throw new Error('Missing fixture settings')
  }
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-4xl p-6">
        <CommitMessageAiPane settings={current} updateSettings={updateSettings} />
      </main>
    </TooltipProvider>
  )
}
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(<Fixture />)
