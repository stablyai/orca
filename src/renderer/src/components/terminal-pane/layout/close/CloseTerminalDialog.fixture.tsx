import { defineFixture } from '../../../../component-fixtures/component-fixture'
import CloseTerminalDialog, { type CloseTerminalDialogCopyKind } from './CloseTerminalDialog'

function dialogFixture(
  copyKind: CloseTerminalDialogCopyKind,
  options: { workspaceName?: string; sleep?: boolean } = {}
) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="h-[320px] bg-background">
        <CloseTerminalDialog
          open
          copyKind={copyKind}
          workspaceName={options.workspaceName}
          {...(options.sleep ? { onSleepInstead: () => {} } : {})}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </div>
    )
  })
}

export const agentWithSleep = dialogFixture('agent', { workspaceName: 'fix-login', sleep: true })

export const agentLongNameWithSleep = dialogFixture('agent', {
  workspaceName: 'Support editable .excalidraw.svg and .excalidraw.png files in the preview pane',
  sleep: true
})

export const agent = dialogFixture('agent', { workspaceName: 'fix-login' })

export const chatAgent = dialogFixture('chat-agent')

export const command = dialogFixture('command')
