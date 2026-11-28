import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { AntigravityAgyCliRow } from './AntigravityAgyCliRow'

const frame = (installed: boolean) => (
  <div className="px-5">
    <AntigravityAgyCliRow
      owner={{ kind: 'local' }}
      installed={installed}
      checking={false}
      onCheckAgain={() => {}}
    />
  </div>
)

export const notInstalled = defineFixture({ width: 640, render: () => frame(false) })

export const updateAvailable = defineFixture({
  width: 640,
  store: {
    agentCliUpdates: new Map([
      [
        '',
        {
          updates: [
            {
              agent: 'antigravity',
              installedVersion: '1.5.4',
              latestVersion: '1.6.2',
              command: 'agy update',
              runnable: true
            }
          ],
          runs: {}
        }
      ]
    ])
  },
  render: () => frame(true)
})
