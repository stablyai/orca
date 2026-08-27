import { useEffect, useRef, useState } from 'react'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import type { CustomProviderDraft } from './custom-provider-draft'
import {
  mergeJsonIntoDraft,
  serializeDraftToJson,
  validateCustomProviderJsonShape
} from './custom-provider-json-view'
import { translate } from '@/i18n/i18n'

type CustomProviderJsonPanelProps = {
  form: CustomProviderDraft
  onFormChange: (updater: (prev: CustomProviderDraft) => CustomProviderDraft) => void
}

// Why: two-way bound raw-JSON <-> structured-form editor. Field edits (or a
// preset click) re-serialize into this box live; typing valid JSON here
// flows back into the fields (and the icon picker above) live. The ref
// suppresses the form->JSON resync for exactly the tick our own edit caused,
// so we never fight the user's cursor/formatting mid-keystroke.
export function CustomProviderJsonPanel({
  form,
  onFormChange
}: CustomProviderJsonPanelProps): React.JSX.Element {
  const [jsonText, setJsonText] = useState(() => serializeDraftToJson(form))
  const [jsonError, setJsonError] = useState<string | null>(null)
  const syncingFromJson = useRef(false)

  useEffect(() => {
    if (syncingFromJson.current) {
      syncingFromJson.current = false
      return
    }
    setJsonText(serializeDraftToJson(form))
    setJsonError(null)
  }, [form])

  const handleChange = (text: string): void => {
    setJsonText(text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON')
      return
    }
    const result = validateCustomProviderJsonShape(parsed)
    if (!result.ok) {
      setJsonError(result.error)
      return
    }
    setJsonError(null)
    syncingFromJson.current = true
    onFormChange((prev) => mergeJsonIntoDraft(prev, result.value))
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="cp-json">
        {translate('auto.components.settings.CustomProviderJsonPanel.title', 'Config JSON')}
      </Label>
      <Textarea
        id="cp-json"
        value={jsonText}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
        rows={9}
        className="font-mono text-xs"
      />
      {jsonError ? (
        <p className="text-xs text-red-400 [overflow-wrap:anywhere]">{jsonError}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.CustomProviderJsonPanel.help',
            'Stays in sync with the fields above in both directions. The token is never shown here.'
          )}
        </p>
      )}
    </div>
  )
}
