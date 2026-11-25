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

function PendingPane({
  height = 600,
  stepping = false
}: {
  height?: number
  stepping?: boolean
}): React.JSX.Element {
  const [home, setHome] = useState(false)
  const [index, setIndex] = useState(0)
  const uid = stepping ? `pending-item-${index}` : 'pending-item'
  const state: BotItemWalkState = stepping
    ? {
        ...walk,
        uid,
        place: { index: index + 1, total: 3 },
        canStep: (direction) => index + direction >= 0 && index + direction < 3,
        step: (direction) => setIndex(index + direction)
      }
    : walk
  return (
    <div className="flex flex-col bg-sidebar" style={{ height }}>
      {home ? (
        <div data-bot-home-panel="">Home</div>
      ) : (
        <BotItemPane
          bot={fixtureCos}
          uid={uid}
          walk={state}
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
  render: () => <PendingPane height={360} />
})

export const clipped = defineFixture({
  width: 252,
  setup: pendingRead,
  render: () => <PendingPane height={160} />
})

export const stepping = defineFixture({
  width: 312,
  setup: pendingRead,
  render: () => <PendingPane stepping />
})
