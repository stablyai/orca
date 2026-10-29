import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { NotificationsPane } from './NotificationsPane'

export const wholeFlow = defineFixture({
  width: 820,
  render: () => {
    const settings = getDefaultSettings('/home/fixture')
    settings.notifications.agentNotificationMode = 'action-or-flow-complete'
    return (
      <div className="p-6">
        <NotificationsPane settings={settings} updateSettings={() => undefined} />
      </div>
    )
  }
})
