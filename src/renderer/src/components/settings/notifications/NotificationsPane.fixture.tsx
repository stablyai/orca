import { useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { defineFixture } from '@/component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { NotificationsPane } from './NotificationsPane'

function QuestionsOnlyPreview(): React.JSX.Element {
  const [settings, setSettings] = useState<GlobalSettings>(() => {
    const initial = useAppStore.getState().settings
    if (!initial) {
      throw new Error('Fixture settings missing')
    }
    return { ...initial, notifications: { ...initial.notifications, agentQuestionsOnly: true } }
  })
  return (
    <div className="p-4">
      <NotificationsPane
        settings={settings}
        updateSettings={(updates) => setSettings((current) => ({ ...current, ...updates }))}
      />
    </div>
  )
}

export const questionsOnly = defineFixture({ width: 640, render: () => <QuestionsOnlyPreview /> })
