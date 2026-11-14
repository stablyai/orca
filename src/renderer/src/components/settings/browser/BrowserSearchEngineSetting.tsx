import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SEARCH_ENGINE_LABELS, type SearchEngine } from '../../../../../shared/browser-url'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { KagiSessionLinkForm } from './KagiSessionLinkForm'
import { useTranslate } from '@/i18n/use-translate'

type BrowserSearchEngineSettingProps = {
  selectedSearchEngine: SearchEngine
  onSearchEngineChange: (engine: SearchEngine) => void
}

export function BrowserSearchEngineSetting({
  selectedSearchEngine,
  onSearchEngineChange
}: BrowserSearchEngineSettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={t('auto.components.settings.BrowserPane.e25fd16b91', 'Default search engine')}
      description={t(
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
      className="flex items-start justify-between gap-4 py-3"
    >
      <div className="space-y-0.5">
        <Label>
          {t('auto.components.settings.BrowserPane.e25fd16b91', 'Default search engine')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t(
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
