import { toast } from 'sonner'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type BrowserHomePageSettingProps = {
  value: string
  onChange: (value: string) => void
  onSave: (url: string | null) => void
}

export function BrowserHomePageSetting({
  value,
  onChange,
  onSave
}: BrowserHomePageSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.BrowserHomePageSetting.70224e37b1',
        'Default Home Page'
      )}
      description={translate(
        'auto.components.settings.BrowserHomePageSetting.6a37540f4b',
        'URL opened when creating a new browser tab. Leave empty to open a blank tab.'
      )}
      keywords={['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank']}
      className="flex items-start justify-between gap-4 py-2"
    >
      <div className="min-w-0 shrink space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.BrowserHomePageSetting.70224e37b1',
            'Default Home Page'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.BrowserHomePageSetting.6a37540f4b',
            'URL opened when creating a new browser tab. Leave empty to open a blank tab.'
          )}
        </p>
      </div>
      <form
        className="flex shrink-0 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = value.trim()
          if (!trimmed) {
            onSave(null)
            return
          }
          const normalized = normalizeBrowserNavigationUrl(trimmed)
          if (normalized && normalized !== ORCA_BROWSER_BLANK_URL) {
            onSave(normalized)
            toast.success(
              translate(
                'auto.components.settings.BrowserHomePageSetting.c6cbd1c105',
                'Home page saved.'
              )
            )
          }
        }}
      >
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.BrowserHomePageSetting.37a30c5bfd',
            'https://google.com'
          )}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="h-7 w-52 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" className="h-7 text-xs">
          {translate('auto.components.settings.BrowserHomePageSetting.d4ddcd0056', 'Save')}
        </Button>
      </form>
    </SearchableSetting>
  )
}
