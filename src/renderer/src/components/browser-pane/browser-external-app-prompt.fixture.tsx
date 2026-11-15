import { useEffect } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../confirmation-dialog'
import { useConfirmationDialog } from '../confirmation-dialog-context'
import { externalAppPrompt } from './browser-external-app-prompt'

function AskOnMount({ appName }: { appName: string }): null {
  const confirm = useConfirmationDialog()
  useEffect(() => {
    void externalAppPrompt.ask(
      confirm,
      { appName, scheme: 'vscode', origin: 'https://github.com' },
      new AbortController().signal
    )
  }, [appName, confirm])
  return null
}

function promptFixture(appName: string) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="h-[280px] bg-background">
        <ConfirmationDialogProvider>
          <AskOnMount appName={appName} />
        </ConfirmationDialogProvider>
      </div>
    )
  })
}

export const shortName = promptFixture('Visual Studio Code')

// The verb button must wrap inside the footer instead of clipping or truncating.
export const longUnbrokenName = promptFixture(
  'VisualStudioCodeInsidersDeveloperPreviewEnterpriseEdition'
)
