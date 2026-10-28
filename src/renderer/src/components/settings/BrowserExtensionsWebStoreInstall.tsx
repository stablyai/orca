import { useState } from 'react'
import { toast } from 'sonner'
import { CHROME_WEB_STORE_HOME_URL } from '../../../../shared/browser-extension-webstore'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

type BrowserExtensionsWebStoreInstallProps = {
  profileId: string
  disabled: boolean
  onFinished: () => void
}

/** "Add from Chrome Web Store": paste a store link or id; main downloads, verifies and asks first. */
export function BrowserExtensionsWebStoreInstall({
  profileId,
  disabled,
  onFinished
}: BrowserExtensionsWebStoreInstallProps): React.JSX.Element {
  const [input, setInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const openBrowserProfileTab = useAppStore((state) => state.openBrowserProfileTabInActiveWorkspace)
  const closeSettingsPage = useAppStore((state) => state.closeSettingsPage)

  const install = async (): Promise<void> => {
    if (!input.trim() || installing) {
      return
    }
    setInstalling(true)
    try {
      const result = await window.api.browser.extensionsInstallFromWebStore({ profileId, input })
      if (result.status === 'installed') {
        setInput('')
        toast.success(
          translate('settings.browser.extensions.webStore.added', 'Added {{name}}', {
            name: result.name
          })
        )
      } else if (result.status === 'failed') {
        toast.error(result.error)
      }
    } finally {
      setInstalling(false)
      onFinished()
    }
  }

  const openStore = async (): Promise<void> => {
    if (await openBrowserProfileTab(CHROME_WEB_STORE_HOME_URL, profileId)) {
      closeSettingsPage()
    } else {
      toast.error(
        translate(
          'settings.browser.extensions.webStore.openFailed',
          'Open a workspace to browse the Chrome Web Store.'
        )
      )
    }
  }

  return (
    <div className="space-y-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void install()
        }}
      >
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={disabled || installing}
          placeholder={translate(
            'settings.browser.extensions.webStore.placeholder',
            'Chrome Web Store link or extension ID'
          )}
          aria-label={translate(
            'settings.browser.extensions.webStore.inputLabel',
            'Add from Chrome Web Store'
          )}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
        />
        <Button
          type="submit"
          variant="outline"
          className="w-24 shrink-0"
          disabled={disabled || installing || input.trim() === ''}
        >
          {installing ? <LoadingSpinner className="size-4" /> : null}
          {installing
            ? translate('settings.browser.extensions.webStore.adding', 'Adding…')
            : translate('settings.browser.extensions.webStore.add', 'Add')}
        </Button>
      </form>
      <Button
        type="button"
        variant="link"
        size="xs"
        className="-ml-2"
        disabled={disabled}
        onClick={() => void openStore()}
      >
        {translate('settings.browser.extensions.webStore.browse', 'Browse the Chrome Web Store')}
      </Button>
    </div>
  )
}
