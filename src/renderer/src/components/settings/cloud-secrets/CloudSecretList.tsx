import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardPaste, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type {
  CloudSecretView,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cloudSecretKindLabel, cloudSecretsErrorCopy } from './cloud-secrets-copy'
import { CloudSecretEditor, type CloudSecretEditorTarget } from './CloudSecretEditor'
import { CloudSecretsPasteEnv } from './CloudSecretsPasteEnv'
import type { CloudSecretListModel } from './use-cloud-secrets'

export type CloudSecretPeople = {
  viewerUserId: string | null
  /** Display name for a teammate, or null when the roster does not know them. */
  nameFor: (userId: string) => string | null
}

export type CloudSecretListMode =
  | { kind: 'idle' }
  | { kind: 'edit'; target: CloudSecretEditorTarget }
  | { kind: 'paste' }

const SAVED_FLASH_MS = 4000
const IDLE: CloudSecretListMode = { kind: 'idle' }
const NONE_SAVED: readonly string[] = []

export function maskedHint(hint: string | null): string {
  return hint ? `••••${hint}` : '••••'
}

function SecretRow({
  secret,
  canWrite,
  people,
  saved,
  now,
  onReplace,
  onRemove
}: {
  secret: CloudSecretView
  canWrite: boolean
  people: CloudSecretPeople
  saved: boolean
  /** Read once per list so every row ages against the same moment. */
  now: number
  onReplace: () => void
  onRemove: () => Promise<CloudSecretsErrorCode | null>
}): React.JSX.Element {
  const t = useTranslate()
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<CloudSecretsErrorCode | null>(null)
  const who =
    secret.updatedBy === people.viewerUserId
      ? t('cloudSecrets.list.byYou', 'you')
      : (people.nameFor(secret.updatedBy) ?? t('cloudSecrets.list.byTeammate', 'a teammate'))
  const when = formatUiRelativeTime(Math.min(0, secret.updatedAt - now))

  return (
    <li
      className="px-3 py-2"
      data-cloud-secret={secret.name}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirming && !removing) {
          event.stopPropagation()
          setConfirming(false)
        }
      }}
    >
      <div className="flex min-h-7 items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <code title={secret.name} className="min-w-0 truncate font-mono text-xs">
            {secret.name}
          </code>
          {secret.kind === 'agent_key' ? (
            <Badge variant="referenceLabel">
              <KeyRound />
              {cloudSecretKindLabel(secret.name, t)}
            </Badge>
          ) : null}
        </span>
        <span className="w-[9ch] shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground">
          <span aria-hidden>{maskedHint(secret.hint)}</span>
          <span className="sr-only">
            {secret.hint
              ? t('cloudSecrets.list.hintLabel', 'Value hidden, ends in {{hint}}', {
                  hint: secret.hint
                })
              : t('cloudSecrets.list.hiddenLabel', 'Value hidden')}
          </span>
        </span>
        <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground md:inline">
          {saved ? (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-foreground motion-safe:animate-in motion-safe:fade-in-0"
            >
              <Check className="size-3.5" />
              {t('cloudSecrets.list.saved', 'Saved')}
            </span>
          ) : (
            t('cloudSecrets.list.updated', '{{who}} · {{when}}', { who, when })
          )}
        </span>
        {/* Reserved for members too, so columns line up in every role. */}
        <div className="flex w-32 shrink-0 items-center justify-end gap-0.5">
          {canWrite ? (
            confirming ? (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={removing}
                  onClick={() => setConfirming(false)}
                >
                  {t('cloudSecrets.list.keep', 'Keep')}
                </Button>
                <Button
                  variant="destructive-chip"
                  size="xs"
                  disabled={removing}
                  autoFocus
                  onClick={() => {
                    setRemoving(true)
                    void onRemove().then((failure) => {
                      setRemoving(false)
                      setError(failure)
                      if (failure) {
                        setConfirming(false)
                      }
                    })
                  }}
                >
                  {t('cloudSecrets.list.confirmDelete', 'Delete')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="xs" data-replace={secret.name} onClick={onReplace}>
                  {t('cloudSecrets.list.replace', 'Replace')}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setConfirming(true)}
                      aria-label={t('cloudSecrets.list.delete', 'Delete {{name}}', {
                        name: secret.name
                      })}
                    >
                      <Trash2 />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {t('cloudSecrets.list.deleteTooltip', 'Delete')}
                  </TooltipContent>
                </Tooltip>
              </>
            )
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {cloudSecretsErrorCopy(error, t)}
        </p>
      ) : null}
    </li>
  )
}

/** One scope's secrets: names and hints only, with add / replace / delete / paste for writers. */
export function CloudSecretList({
  model,
  canWrite,
  people,
  emptyTitle,
  emptyDetail,
  initialMode = IDLE,
  initialSaved = NONE_SAVED,
  onSetUpAgent
}: {
  model: CloudSecretListModel
  /** Where a refused subscription token points: "Add an agent" with its Sign in option. */
  onSetUpAgent?: () => void
  canWrite: boolean
  people: CloudSecretPeople
  emptyTitle: string
  emptyDetail: string
  /** Fixtures only. */
  initialMode?: CloudSecretListMode
  /** Fixtures only. */
  initialSaved?: readonly string[]
}): React.JSX.Element {
  const t = useTranslate()
  const [mode, setMode] = useState<CloudSecretListMode>(initialMode)
  const [now] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  // Closing a form or deleting a row would drop focus on <body>; hand it back to the trigger.
  const focusLater = (selector: string): void => {
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
    )
  }
  const closeTo = (selector: string): void => {
    setMode(IDLE)
    focusLater(selector)
  }
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set(initialSaved))

  useEffect(() => {
    if (saved.size === 0) {
      return
    }
    const timer = setTimeout(() => setSaved(new Set()), SAVED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [saved])

  const markSaved = (names: readonly string[]): void => setSaved(new Set(names))

  if (model.list.status === 'loading') {
    return (
      <div className="space-y-px rounded-md border border-border/60" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 px-3 py-2.5">
            <div className="h-3 w-40 rounded bg-muted motion-safe:animate-pulse" />
            <div className="ml-auto h-3 w-12 rounded bg-muted motion-safe:animate-pulse" />
          </div>
        ))}
        <span className="sr-only">{t('cloudSecrets.list.loading', 'Loading secrets…')}</span>
      </div>
    )
  }

  if (model.list.status === 'failed') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3">
        <p role="alert" className="text-xs text-muted-foreground">
          {model.list.error === 'unauthorized' || model.list.error === 'not_configured'
            ? cloudSecretsErrorCopy(model.list.error, t)
            : t('cloudSecrets.list.loadFailed', 'Couldn’t load secrets.')}
        </p>
        <Button variant="outline" size="xs" onClick={model.reload}>
          <RefreshCw />
          {t('cloudSecrets.list.retry', 'Try again')}
        </Button>
      </div>
    )
  }

  const secrets = [...model.list.value].sort((a, b) => a.name.localeCompare(b.name))
  const actions =
    canWrite && mode.kind === 'idle' ? (
      <>
        <Button
          variant="outline"
          size="sm"
          data-action="add"
          onClick={() => setMode({ kind: 'edit', target: { kind: 'add' } })}
        >
          <Plus />
          {t('cloudSecrets.list.add', 'Add secret')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-action="paste"
          onClick={() => setMode({ kind: 'paste' })}
        >
          <ClipboardPaste />
          {t('cloudSecrets.list.paste', 'Paste .env')}
        </Button>
      </>
    ) : null
  const replacing = mode.kind === 'edit' && mode.target.kind === 'replace' ? mode.target.name : null

  return (
    <div ref={rootRef} className="space-y-3">
      {secrets.length === 0 && mode.kind === 'idle' ? (
        <div className="rounded-md border border-dashed border-border/60 px-4 py-5 text-center">
          <p className="text-sm font-medium">{emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
            {emptyDetail}
          </p>
          {actions ? (
            <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : secrets.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {secrets.map((secret) =>
            replacing === secret.name ? (
              <li key={secret.name} className="px-3 py-2.5">
                <CloudSecretEditor
                  inline
                  onSetUpAgent={onSetUpAgent}
                  target={{ kind: 'replace', name: secret.name, hint: secret.hint }}
                  onSave={async (name, value) => {
                    const failure = await model.put(name, value)
                    if (!failure) {
                      markSaved([name])
                      closeTo(`[data-replace="${name}"]`)
                    }
                    return failure
                  }}
                  onCancel={() => closeTo(`[data-replace="${secret.name}"]`)}
                />
              </li>
            ) : (
              <SecretRow
                key={secret.name}
                secret={secret}
                canWrite={canWrite}
                people={people}
                saved={saved.has(secret.name)}
                now={now}
                onReplace={() =>
                  setMode({
                    kind: 'edit',
                    target: { kind: 'replace', name: secret.name, hint: secret.hint }
                  })
                }
                onRemove={async () => {
                  const failure = await model.remove(secret.name)
                  if (!failure) {
                    focusLater('[data-replace], [data-action="add"]')
                  }
                  return failure
                }}
              />
            )
          )}
        </ul>
      ) : null}

      {mode.kind === 'edit' && mode.target.kind === 'add' ? (
        <CloudSecretEditor
          onSetUpAgent={onSetUpAgent}
          target={mode.target}
          onSave={async (name, value) => {
            const failure = await model.put(name, value)
            if (!failure) {
              markSaved([name])
              closeTo(`[data-replace="${name}"]`)
            }
            return failure
          }}
          onCancel={() => closeTo('[data-action="add"]')}
        />
      ) : null}

      {mode.kind === 'paste' ? (
        <CloudSecretsPasteEnv
          existingNames={secrets.map((secret) => secret.name)}
          onSave={async (set) => {
            const result = await model.batch(set)
            if (typeof result !== 'string') {
              markSaved(result.secrets.map((secret) => secret.name))
              if (result.errors.length === 0) {
                closeTo('[data-action="paste"]')
              }
            }
            return result
          }}
          onCancel={() => closeTo('[data-action="paste"]')}
        />
      ) : null}

      {secrets.length > 0 && actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
