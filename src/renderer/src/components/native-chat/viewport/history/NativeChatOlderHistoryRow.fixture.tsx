import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatOlderHistoryRow } from './NativeChatOlderHistoryRow'

function Row({ loadFailed }: { loadFailed: boolean }): React.JSX.Element {
  return (
    <div className="relative h-12 bg-background">
      <NativeChatOlderHistoryRow
        olderHistory={{
          sentinelRef: () => undefined,
          isAutoLoadEnabled: false,
          loadFailed,
          loadEarlierManually: () => undefined,
          loadEarlier: async () => 'unchanged'
        }}
        loadingEarlier={false}
      />
    </div>
  )
}

/** What a failed read used to leave: the same button, no reason given. */
export const manual = defineFixture({ width: 480, render: () => <Row loadFailed={false} /> })

export const failed = defineFixture({ width: 480, render: () => <Row loadFailed /> })

/** A narrow split pane: the message truncates and Retry stays whole inside the 40 px row. */
export const failedNarrow = defineFixture({ width: 200, render: () => <Row loadFailed /> })
