import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { getSmartWorkspaceNameModes } from './smart-workspace-localized-options'
import { SmartWorkspaceSourceTabs } from './SmartWorkspaceSourceTabs'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'

function Preview({ initial = 'smart' }: { initial?: SmartNameMode }) {
  const [mode, setMode] = useState<SmartNameMode>(initial)
  return (
    <SmartWorkspaceSourceTabs
      model={{ mode, availableModes: getSmartWorkspaceNameModes() }}
      onModeChange={setMode}
    />
  )
}

export const iconOnly = defineFixture({
  width: 480,
  render: () => (
    <div className="rounded-xl border border-border bg-background p-5">
      <Preview />
    </div>
  )
})

export const tooltip = defineFixture({
  width: 560,
  render: () => (
    <div className="rounded-xl border border-border bg-background p-5 pb-12">
      <Preview />
    </div>
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector('[data-smart-name-mode="github"]')
    trigger?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    trigger?.dispatchEvent(new FocusEvent('focus'))
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
})

/** Tasks open: the source switcher (GitHub · Linear · Jira · GitLab) under the four tabs. */
export const tasksOpen = defineFixture({
  width: 480,
  render: () => (
    <div className="rounded-xl border border-border bg-background p-5">
      <Preview initial="linear" />
    </div>
  )
})
