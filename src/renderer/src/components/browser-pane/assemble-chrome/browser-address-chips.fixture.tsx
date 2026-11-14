import { useRef } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ArtifactPublishButton } from '../../artifacts/ArtifactPublishButton'
import BrowserAddressBar from './BrowserAddressBar'
import { BrowserOpenSourceFileButton } from './browser-address-chips'

function AddressBar(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <BrowserAddressBar
      pageId="address-icons"
      value="file:///workspace/report.html"
      inputRef={inputRef}
      onChange={() => {}}
      onSubmit={() => {}}
      onNavigate={() => {}}
      trailing={
        <>
          <BrowserOpenSourceFileButton onOpen={() => {}} />
          <ArtifactPublishButton
            sourceKey="/workspace/report.html"
            size="icon-xs"
            variant="muted-field-icon"
            createRequest={async () => {
              throw new Error('Preview only')
            }}
          />
        </>
      }
    />
  )
}

export const addressIcons = defineFixture({ width: 560, render: () => <AddressBar /> })
