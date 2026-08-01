import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH,
  CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES,
  isValidContextPressureSoftLimitKey,
  normalizeContextPressureSoftLimitKey
} from '../../../../shared/agent-context-pressure'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

function parseSoftLimitTokens(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null
}

type ContextPressureSoftLimitsEditorProps = {
  softLimits: Record<string, number>
  onCommit: (next: Record<string, number>) => void
}

export function ContextPressureSoftLimitsEditor({
  softLimits,
  onCommit
}: ContextPressureSoftLimitsEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState<{ key: string; tokens: string } | null>(null)
  const entries = Object.entries(softLimits)
  const draftKey = draft?.key.trim() ?? ''
  const draftTokens = draft ? parseSoftLimitTokens(draft.tokens) : null
  const draftKeyInvalid = draftKey.length > 0 && !isValidContextPressureSoftLimitKey(draftKey)
  const draftValid = draftKey.length > 0 && !draftKeyInvalid && draftTokens !== null
  const draftCollision = Object.keys(softLimits).some(
    (key) =>
      normalizeContextPressureSoftLimitKey(key) === normalizeContextPressureSoftLimitKey(draftKey)
  )

  const commitDraft = (): void => {
    if (!draft || !draftValid || draftTokens === null || draftCollision) {
      return
    }
    onCommit({ ...softLimits, [draftKey]: draftTokens })
    setDraft(null)
  }

  const commitRow = (originalKey: string, nextKey: string, nextTokens: number): void => {
    const next: Record<string, number> = {}
    for (const [key, tokens] of entries) {
      if (key !== originalKey) {
        next[key] = tokens
      }
    }
    next[nextKey] = nextTokens
    onCommit(next)
  }

  const removeRow = (key: string): void => {
    const next = { ...softLimits }
    delete next[key]
    onCommit(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ExperimentalPane.contextPressure.softLimitsLabel',
              'Soft limits'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ExperimentalPane.contextPressure.softLimitsDescription',
              'Absolute token caps keyed by global, provider:<id>, agent:<type>, or model:<id>. The most specific matching cap wins.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={draft !== null || entries.length >= CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES}
          onClick={() => setDraft({ key: '', tokens: '' })}
        >
          <Plus className="size-3.5" />
          {translate(
            'auto.components.settings.ExperimentalPane.contextPressure.addLimit',
            'Add limit'
          )}
        </Button>
      </div>
      {entries.map(([key, tokens]) => (
        <SoftLimitRow
          key={key}
          entryKey={key}
          tokens={tokens}
          onCommit={(nextKey, nextTokens) => commitRow(key, nextKey, nextTokens)}
          existingKeys={Object.keys(softLimits)}
          onRemove={() => removeRow(key)}
        />
      ))}
      {draft ? (
        <div className="flex items-center gap-2">
          <Input
            value={draft.key}
            maxLength={CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH}
            placeholder={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.softLimitKeyPlaceholder',
              'global, provider:id, model:id, or agent:type'
            )}
            aria-label={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.softLimitKeyAriaLabel',
              'Soft limit model ID or agent type'
            )}
            className="flex-1 font-mono text-xs"
            onChange={(e) => {
              const key = e.target.value
              setDraft((current) => (current ? { ...current, key } : current))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitDraft()
              }
            }}
          />
          <Input
            type="number"
            min={1}
            step={1}
            value={draft.tokens}
            placeholder={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.softLimitTokensPlaceholder',
              'Tokens'
            )}
            aria-label={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.softLimitTokensAriaLabel',
              'Soft limit in tokens'
            )}
            className="number-input-clean w-28 tabular-nums"
            onChange={(e) => {
              const tokens = e.target.value
              setDraft((current) => (current ? { ...current, tokens } : current))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitDraft()
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!draftValid || draftCollision}
            onClick={commitDraft}
          >
            {translate(
              'auto.components.settings.ExperimentalPane.contextPressure.confirmAddLimit',
              'Add'
            )}
          </Button>
          {draftCollision ? (
            <span className="text-xs text-destructive" role="alert">
              {translate(
                'auto.components.settings.ExperimentalPane.contextPressure.duplicateLimit',
                'A soft limit with this key already exists.'
              )}
            </span>
          ) : draftKeyInvalid ? (
            <span className="text-xs text-destructive" role="alert">
              {translate(
                'auto.components.settings.ExperimentalPane.contextPressure.invalidLimitKey',
                'Use global, provider:<id>, agent:<type>, or model:<id>.'
              )}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={translate(
              'auto.components.settings.ExperimentalPane.contextPressure.cancelAddLimit',
              'Cancel adding soft limit'
            )}
            onClick={() => setDraft(null)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

type SoftLimitRowProps = {
  entryKey: string
  tokens: number
  onCommit: (nextKey: string, nextTokens: number) => void
  onRemove: () => void
  existingKeys: string[]
}

function SoftLimitRow({
  entryKey,
  tokens,
  onCommit,
  onRemove,
  existingKeys
}: SoftLimitRowProps): React.JSX.Element {
  const [keyDraft, setKeyDraft] = useState(entryKey)
  const [tokensDraft, setTokensDraft] = useState(String(tokens))
  const [duplicate, setDuplicate] = useState(false)
  const [invalidKey, setInvalidKey] = useState(false)
  const [prev, setPrev] = useState({ entryKey, tokens })
  // Why: render-time prop sync (NumberField pattern) so external updates refresh drafts.
  if (prev.entryKey !== entryKey || prev.tokens !== tokens) {
    setPrev({ entryKey, tokens })
    setKeyDraft(entryKey)
    setTokensDraft(String(tokens))
  }

  const commit = (): void => {
    const nextKey = keyDraft.trim()
    const nextTokens = parseSoftLimitTokens(tokensDraft)
    const collision = existingKeys.some(
      (key) =>
        key !== entryKey &&
        normalizeContextPressureSoftLimitKey(key) === normalizeContextPressureSoftLimitKey(nextKey)
    )
    if (collision) {
      setDuplicate(true)
      setInvalidKey(false)
      setKeyDraft(entryKey)
      setTokensDraft(String(tokens))
      return
    }
    setDuplicate(false)
    if (nextKey && !isValidContextPressureSoftLimitKey(nextKey)) {
      setInvalidKey(true)
      setKeyDraft(entryKey)
      setTokensDraft(String(tokens))
      return
    }
    setInvalidKey(false)
    if (!nextKey || nextTokens === null) {
      // Why: invalid edits revert to the persisted entry instead of being stored.
      setKeyDraft(entryKey)
      setTokensDraft(String(tokens))
      return
    }
    if (nextKey === entryKey && nextTokens === tokens) {
      return
    }
    onCommit(nextKey, nextTokens)
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={keyDraft}
        maxLength={CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH}
        aria-label={translate(
          'auto.components.settings.ExperimentalPane.contextPressure.softLimitKeyAriaLabel',
          'Soft limit model ID or agent type'
        )}
        className="flex-1 font-mono text-xs"
        onChange={(e) => setKeyDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
          }
        }}
      />
      <Input
        type="number"
        min={1}
        step={1}
        value={tokensDraft}
        aria-label={translate(
          'auto.components.settings.ExperimentalPane.contextPressure.softLimitTokensAriaLabel',
          'Soft limit in tokens'
        )}
        className="number-input-clean w-28 tabular-nums"
        onChange={(e) => setTokensDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
          }
        }}
      />
      <span className="shrink-0 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ExperimentalPane.contextPressure.softLimitTokensSuffix',
          'tokens'
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={translate(
          'auto.components.settings.ExperimentalPane.contextPressure.removeLimit',
          'Remove soft limit for {{value0}}',
          { value0: entryKey }
        )}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
      {duplicate ? (
        <span className="text-xs text-destructive" role="alert">
          {translate(
            'auto.components.settings.ExperimentalPane.contextPressure.duplicateLimit',
            'A soft limit with this key already exists.'
          )}
        </span>
      ) : invalidKey ? (
        <span className="text-xs text-destructive" role="alert">
          {translate(
            'auto.components.settings.ExperimentalPane.contextPressure.invalidLimitKey',
            'Use global, provider:<id>, agent:<type>, or model:<id>.'
          )}
        </span>
      ) : null}
    </div>
  )
}
