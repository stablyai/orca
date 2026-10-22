import { useId } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { Plus, X } from 'lucide-react'
import type { RuntimeEdgeAuthHeader } from '../../../../shared/runtime-edge-auth-types'
import { normalizeEndpointAuthHeaders } from '../../../../shared/network/endpoint-auth-headers'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export type RuntimeEdgeAuthDraftRow = RuntimeEdgeAuthHeader & { id: string }
export function newRuntimeEdgeAuthRow(): RuntimeEdgeAuthDraftRow {
  return { id: createBrowserUuid(), name: '', value: '' }
}
export function RuntimeEdgeAuthFields({
  rows,
  onChange,
  disabled = false
}: {
  rows: RuntimeEdgeAuthDraftRow[]
  onChange: (rows: RuntimeEdgeAuthDraftRow[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const prefix = useId()
  const normalized = normalizeEndpointAuthHeaders(rows)
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-medium">
        {translate('settings.edgeAuth.title', 'Edge authentication (optional)')}
      </legend>
      <p className="text-xs text-muted-foreground">
        {translate(
          'settings.edgeAuth.hint',
          'For a protected secure tunnel, enter its HTTP handshake headers. Values stay in protected storage and never enter pairing links. Redirects are refused.'
        )}
      </p>
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor={`${prefix}-${row.id}-name`}>
              {translate('settings.edgeAuth.name', 'Header {{number}} name', { number: index + 1 })}
            </Label>
            <Input
              id={`${prefix}-${row.id}-name`}
              value={row.name}
              autoComplete="off"
              spellCheck={false}
              placeholder="CF-Access-Client-Id"
              onChange={(event) =>
                onChange(
                  rows.map((current) =>
                    current.id === row.id ? { ...current, name: event.target.value } : current
                  )
                )
              }
            />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor={`${prefix}-${row.id}-value`}>
              {translate('settings.edgeAuth.value', 'Header {{number}} value', {
                number: index + 1
              })}
            </Label>
            <Input
              id={`${prefix}-${row.id}-value`}
              type="password"
              value={row.value}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                onChange(
                  rows.map((current) =>
                    current.id === row.id ? { ...current, value: event.target.value } : current
                  )
                )
              }
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={translate('settings.edgeAuth.remove', 'Remove header {{number}}', {
              number: index + 1
            })}
            onClick={() =>
              onChange(
                rows.length > 1
                  ? rows.filter((current) => current.id !== row.id)
                  : [newRuntimeEdgeAuthRow()]
              )
            }
          >
            <X />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={rows.length >= 8}
        onClick={() => onChange([...rows, newRuntimeEdgeAuthRow()])}
      >
        <Plus />
        {translate('settings.edgeAuth.add', 'Add header')}
      </Button>
      {!normalized.ok ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'settings.edgeAuth.invalid',
            'Enter valid header names and printable ASCII values.'
          )}
        </p>
      ) : null}
    </fieldset>
  )
}
