import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SEARCH_ENGINE_LABELS, type SearchEngine } from '../../../../shared/browser-url'
import { SearchableSetting } from './SearchableSetting'
import { KagiSessionLinkForm } from './KagiSessionLinkForm'
import { translate } from '@/i18n/i18n'

type BrowserSearchEngineSettingProps = {
  selectedSearchEngine: SearchEngine
  onSearchEngineChange: (engine: SearchEngine) => void
}

export function BrowserSearchEngineSetting({
  selectedSearchEngine,
  onSearchEngineChange
}: BrowserSearchEngineSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate('auto.components.settings.BrowserPane.0d9c987f21', 'Default Search Engine')}
      description={translate(
        'auto.components.settings.BrowserPane.7b225c78f5',
        'Search engine used when typing non-URL text in the address bar.'
      )}
      keywords={[
        'browser',
        'search',
        'engine',
        'google',
        'duckduckgo',
        'bing',
        'kagi',
        'session',
        'private',
        'token',
        'omnibox'
      ]}
      className="flex items-start justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>
          {translate('auto.components.settings.BrowserPane.0d9c987f21', 'Default Search Engine')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.BrowserPane.3e46903ad4',
            'Used when typing non-URL text in the address bar.'
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <Select
          value={selectedSearchEngine}
          onValueChange={(value) => onSearchEngineChange(value as SearchEngine)}
        >
          <SelectTrigger className="h-7 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(SEARCH_ENGINE_LABELS) as SearchEngine[]).map((engine) => (
              <SelectItem key={engine} value={engine} className="text-xs">
                {SEARCH_ENGINE_LABELS[engine]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedSearchEngine === 'kagi' ? <KagiSessionLinkForm /> : null}
      </div>
    </SearchableSetting>
  )
}
