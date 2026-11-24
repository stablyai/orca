import { useEffect } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { LinkRoutingPreferenceDialogProvider } from './link-routing-preference-dialog'
import { useLinkRoutingPreferenceDialog } from './link-routing-preference-dialog-context'

function AskOnMount({ openLinksInAppDefault }: { openLinksInAppDefault: boolean }): null {
  const requestPreference = useLinkRoutingPreferenceDialog()
  useEffect(() => {
    void requestPreference({ url: 'https://github.com/stablyai/orca', openLinksInAppDefault })
  }, [openLinksInAppDefault, requestPreference])
  return null
}

function dialogFixture(openLinksInAppDefault: boolean) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="h-[280px] bg-background">
        <LinkRoutingPreferenceDialogProvider>
          <AskOnMount openLinksInAppDefault={openLinksInAppDefault} />
        </LinkRoutingPreferenceDialogProvider>
      </div>
    )
  })
}

export const openInOrca = dialogFixture(false)

export const keepInOrca = dialogFixture(true)
