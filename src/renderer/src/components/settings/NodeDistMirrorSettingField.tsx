import type React from 'react'
import { useState } from 'react'
import { normalizeNodeDistMirrorUrl } from '../../../../shared/node-dist-mirror'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import { nodeDistMirrorRefusalText } from '@/ssh/ssh-host-node-download-copy'

type MirrorDraft = { source: string; text: string; error: string | null }

type NodeDistMirrorSettingFieldProps = {
  value: string | undefined
  onCommit: (value: string) => void
}

/** Where Orca downloads the Node it installs on SSH and WSL servers, when nodejs.org is out of reach. */
export function NodeDistMirrorSettingField({
  value,
  onCommit
}: NodeDistMirrorSettingFieldProps): React.JSX.Element {
  const source = value ?? ''
  const [draft, setDraft] = useState<MirrorDraft>({ source, text: source, error: null })
  // Why stored, not derived: a draft left keyed to an old value would match again if it returned.
  const current: MirrorDraft =
    draft.source === source ? draft : { source, text: source, error: null }
  if (current !== draft) {
    setDraft(current)
  }

  const commit = (): void => {
    const normalized = normalizeNodeDistMirrorUrl(current.text)
    if (!normalized.ok) {
      setDraft({ ...current, error: nodeDistMirrorRefusalText(normalized.reason) })
      return
    }
    setDraft({ source, text: normalized.value, error: null })
    if (normalized.value !== source) {
      onCommit(normalized.value)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="settings-node-dist-mirror-url">
        {translate(
          'auto.components.settings.AdvancedNetworkSettingsSection.nodeDistMirrorLabel',
          'Node.js Download Mirror'
        )}
      </Label>
      <Input
        id="settings-node-dist-mirror-url"
        value={current.text}
        onChange={(e) => setDraft({ ...current, text: e.target.value, error: null })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
        placeholder={translate(
          'auto.components.settings.AdvancedNetworkSettingsSection.nodeDistMirrorPlaceholder',
          'https://mirror.example.com/nodejs/dist'
        )}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={current.error ? true : undefined}
        className="font-mono text-xs"
      />
      {current.error ? (
        <p className="text-xs text-destructive">{current.error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AdvancedNetworkSettingsSection.nodeDistMirrorDescription',
            'Optional. A copy of nodejs.org/dist that Orca uses first when it installs Node on SSH and WSL servers. Each file is still checked against the release Orca expects.'
          )}
        </p>
      )}
    </div>
  )
}
