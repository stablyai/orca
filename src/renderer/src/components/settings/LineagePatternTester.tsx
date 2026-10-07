import React, { useEffect, useState } from 'react'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import { SettingsRow } from './SettingsFormControls'

const TEST_DEBOUNCE_MS = 300
// why: the IPC rejects an empty tower name, but validating the regex alone still needs a probe
const REGEX_PROBE_NAME = 'probe'

async function validateKeyRegex(keyRegex: string): Promise<string | null> {
  const testPattern = window.api?.git?.lineageTestPattern
  if (typeof testPattern === 'function') {
    try {
      const result = await testPattern({ towerName: REGEX_PROBE_NAME, keyRegex })
      return result.error ?? null
    } catch {
      // why: hosts without the lineage IPC fall through to the local syntax check below
    }
  }
  try {
    new RegExp(keyRegex)
    return null
  } catch {
    return translate(
      'auto.components.settings.lineageDiscovery.keyPatternInvalid',
      'Invalid key pattern'
    )
  }
}

type LineagePatternTesterProps = {
  savedKeyRegex: string
  disabled: boolean
  onValidKeyRegex: (keyRegex: string) => void
}

export function LineagePatternTester({
  savedKeyRegex,
  disabled,
  onValidKeyRegex
}: LineagePatternTesterProps): React.JSX.Element {
  const [regexDraft, setRegexDraft] = useState(savedKeyRegex)
  const [towerName, setTowerName] = useState('')
  const [regexError, setRegexError] = useState<string | null>(null)
  const [keys, setKeys] = useState<string[] | null>(null)
  // why: web clients reject lineage IPC; hide the live test instead of surfacing a broken control
  const [supported, setSupported] = useState(
    () => typeof window !== 'undefined' && typeof window.api?.git?.lineageTestPattern === 'function'
  )

  useEffect(() => {
    setRegexDraft(savedKeyRegex)
  }, [savedKeyRegex])

  useEffect(() => {
    if (regexDraft === savedKeyRegex && towerName === '') {
      setRegexError(null)
      setKeys(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      if (regexDraft === '') {
        setRegexError(
          translate(
            'auto.components.settings.lineageDiscovery.keyPatternRequired',
            'Key pattern is required'
          )
        )
        return
      }
      const testPattern = window.api?.git?.lineageTestPattern
      if (typeof testPattern !== 'function') {
        setSupported(false)
        return
      }
      testPattern({
        towerName: towerName || REGEX_PROBE_NAME,
        keyRegex: regexDraft
      })
        .then((result) => {
          if (cancelled) {
            return
          }
          setRegexError(result.error ?? null)
          setKeys(towerName ? result.keys : null)
        })
        .catch(() => {
          if (!cancelled) {
            setSupported(false)
          }
        })
    }, TEST_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [regexDraft, towerName, savedKeyRegex])

  // why: saving on every keystroke would persist half-typed patterns; commit only on blur/Enter once valid
  const commitDraft = async (): Promise<void> => {
    const draft = regexDraft
    if (draft === '' || draft === savedKeyRegex) {
      return
    }
    const error = await validateKeyRegex(draft)
    if (error === null) {
      onValidKeyRegex(draft)
    } else {
      setRegexError(error)
    }
  }

  return (
    <>
      <SettingsRow
        label={translate('auto.components.settings.lineageDiscovery.keyPattern', 'Key pattern')}
        description={translate(
          'auto.components.settings.lineageDiscovery.keyPatternDescription',
          'Regular expression that extracts ticket keys from the control tower workspace name.'
        )}
        alignTop
        control={
          <div className="flex w-72 flex-col gap-1">
            <Input
              value={regexDraft}
              disabled={disabled}
              spellCheck={false}
              aria-label={translate(
                'auto.components.settings.lineageDiscovery.keyPattern',
                'Key pattern'
              )}
              aria-invalid={regexError !== null}
              onChange={(event) => setRegexDraft(event.target.value)}
              onBlur={() => void commitDraft()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitDraft()
                }
              }}
            />
            {regexError ? (
              <p data-testid="lineage-key-regex-error" className="text-xs text-destructive">
                {regexError}
              </p>
            ) : null}
          </div>
        }
      />
      {supported ? (
        <SettingsRow
          label={translate('auto.components.settings.lineageDiscovery.testPattern', 'Test pattern')}
          description={translate(
            'auto.components.settings.lineageDiscovery.testPatternDescription',
            'Type a workspace name to preview the keys this pattern extracts.'
          )}
          alignTop
          control={
            <div className="flex w-72 flex-col gap-1">
              <Label className="sr-only" htmlFor="lineage-test-tower-name">
                {translate('auto.components.settings.lineageDiscovery.towerName', 'Tower name')}
              </Label>
              <Input
                id="lineage-test-tower-name"
                value={towerName}
                disabled={disabled}
                placeholder={translate(
                  'auto.components.settings.lineageDiscovery.towerNamePlaceholder',
                  'gnios::ABC-123 new loan'
                )}
                onChange={(event) => setTowerName(event.target.value)}
              />
              {keys ? (
                <p data-testid="lineage-test-keys" className="text-xs text-muted-foreground">
                  {keys.length > 0
                    ? keys.join(', ')
                    : translate(
                        'auto.components.settings.lineageDiscovery.noKeysFound',
                        'No keys found'
                      )}
                </p>
              ) : null}
            </div>
          }
        />
      ) : null}
    </>
  )
}
