import { defineFixture } from '../../component-fixtures/component-fixture'
import type { BotImportDone } from '../../../../shared/bots/bot-import-cards'
import { NativeChatImportDoneCard } from './NativeChatImportDoneCard'

const done: BotImportDone = {
  botId: 'bot-atlas',
  app: 'Molty',
  name: 'Molty',
  created: [
    { kind: 'soul', what: 'Soul' },
    { kind: 'memory', what: 'Memory', detail: '12 facts, 6 topics' },
    { kind: 'automations', what: '3 automations', detail: 'paused' },
    { kind: 'tools', what: 'Notion' }
  ],
  stayed: ['Saved logins'],
  paused: 3
}

function Done(): React.JSX.Element {
  return (
    <div className="p-4">
      <NativeChatImportDoneCard done={done} />
    </div>
  )
}

export const finished = defineFixture({ width: 640, render: () => <Done /> })

export const finishedNarrow = defineFixture({ width: 380, render: () => <Done /> })
