import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudVersionSkewNotice, type CloudVersionSkewDirection } from './CloudWorkspaceNotice'

const noop = (): void => {}

function skewNotice(direction: CloudVersionSkewDirection) {
  return defineFixture({
    width: 420,
    render: () => (
      <div className="bg-background p-4">
        <CloudVersionSkewNotice
          direction={direction}
          onCheckForUpdates={noop}
          onCreateWorkspace={noop}
          onDismiss={noop}
        />
      </div>
    )
  })
}

export const sandboxOlder = skewNotice('sandbox-older')
export const desktopOlder = skewNotice('desktop-older')
