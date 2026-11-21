import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { BotItemPane } from './BotItemPane'
import type { BotItemWalkState } from './use-bot-item-walk'

const walk: BotItemWalkState = {
  uid: 'pending-item',
  place: null,
  pending: false,
  failed: false,
  canStep: () => false,
  open: () => {},
  step: () => {},
  retry: () => {},
  markGone: () => {},
  close: () => null
}

function pendingRead(): void {
  const runtime = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: (request: Parameters<typeof runtime.call>[0]) =>
      request.method === 'bots.items.owner.show' ? new Promise(() => {}) : runtime.call(request)
  })
}

function PendingPane({ short = false }: { short?: boolean }): React.JSX.Element {
  const [home, setHome] = useState(false)
  return (
    <div
      className={
        short ? 'flex h-[360px] flex-col bg-sidebar' : 'flex h-[600px] flex-col bg-sidebar'
      }
    >
      {home ? (
        <div data-bot-home-panel="">Home</div>
      ) : (
        <BotItemPane
          bot={fixtureCos}
          uid="pending-item"
          walk={walk}
          offline={false}
          onBack={() => setHome(true)}
        />
      )}
    </div>
  )
}

export const pending = defineFixture({
  width: 392,
  setup: pendingRead,
  render: () => <PendingPane />
})

export const narrow = defineFixture({
  width: 312,
  setup: pendingRead,
  render: () => <PendingPane />
})

export const shortNarrow = defineFixture({
  width: 252,
  setup: pendingRead,
  render: () => <PendingPane short />
})
