import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { NativeChatCodeWrapDefaultContext } from './native-chat-code-wrap-default'

const LONG_LINE =
  'const sorted = await listWorkspacesByMostRecentActivity({ includeArchived: false, limit: 100, hosts: selectedHosts });'

function transcriptCode(wrap: boolean) {
  return (
    <NativeChatCodeWrapDefaultContext.Provider value={wrap}>
      <div className="max-w-md p-4">
        <NativeChatCodeBlock language="typescript" plain>
          <code>{LONG_LINE}</code>
        </NativeChatCodeBlock>
      </div>
    </NativeChatCodeWrapDefaultContext.Provider>
  )
}

/** The default off: long code keeps its horizontal scrollbar, as transcripts look today. */
export const wrapOff = defineFixture({ width: 420, render: () => transcriptCode(false) })
/** The default on: long code starts wrapped, with the per-block button still toggling either way. */
export const wrapOn = defineFixture({ width: 420, render: () => transcriptCode(true) })
