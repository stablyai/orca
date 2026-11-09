import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardPaste, KeyRound, Plus } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type {
  CloudSecretView,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Badge } from '../../ui/badge'
import { InlineError } from '../../ui/inline-error'
import { Skeleton } from '../../ui/skeleton'
import { Button } from '../../ui/button'
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
        <span
          className="w-40 shrink-0 truncate text-xs text-muted-foreground"
          title={t('cloudSecrets.list.updated', '{{who}} · {{when}}', { who, when })}
        >
          {saved ? (
            <span className="inline-flex items-center gap-1 text-foreground motion-safe:animate-in motion-safe:fade-in-0">
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
                  variant="destructive-chip"
                  size="xs"
                  aria-label={t('cloudSecrets.list.confirmDeleteLabel', 'Confirm delete {{name}}', {
                    name: secret.name
                  })}
                  aria-disabled={removing || undefined}
                  aria-busy={removing || undefined}
                  onClick={() => {
                    if (removing) {
                      return
                    }
                    setRemoving(true)
                    void onRemove().then((failure) => {
                      setRemoving(false)
                      setError(failure)
                      if (failure) {
                        setConfirming(false)
                        // A failed delete keeps the row, so focus stays on its Delete.
                        requestAnimationFrame(() =>
                          document
                            .querySelector<HTMLElement>(`[data-delete="${secret.name}"]`)
                            ?.focus()
                        )
                      }
                    })
                  }}
                >
                  {t('cloudSecrets.list.confirmDelete', 'Delete')}
                </Button>
                {/* Keep takes focus and sits where Delete was, so a double click cannot delete. */}
                <Button
                  variant="ghost"
                  size="xs"
                  autoFocus
                  data-keep={secret.name}
                  onClick={() => {
                    setConfirming(false)
                    requestAnimationFrame(() =>
                      document.querySelector<HTMLElement>(`[data-delete="${secret.name}"]`)?.focus()
                    )
                  }}
                >
                  {t('cloudSecrets.list.keep', 'Keep')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="xs" data-replace={secret.name} onClick={onReplace}>
                  {t('cloudSecrets.list.replace', 'Replace')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  data-delete={secret.name}
                  onClick={() => setConfirming(true)}
                  aria-label={t('cloudSecrets.list.delete', 'Delete {{name}}', {
                    name: secret.name
                  })}
                >
                  {t('cloudSecrets.list.deleteTooltip', 'Delete')}
                </Button>
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
  description,
  emptyAction,
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
  /** One line about who gets this scope, beside the Add / Paste actions. */
  description?: string
  /** An extra way to fill an empty scope, such as "Set up an agent". */
  emptyAction?: React.ReactNode
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
            <Skeleton className="h-3 w-40" />
            <Skeleton className="ml-auto h-3 w-12" />
          </div>
        ))}
        <span className="sr-only">{t('cloudSecrets.list.loading', 'Loading secrets…')}</span>
      </div>
    )
  }

  if (model.list.status === 'failed') {
    return (
      <InlineError
        title={
          model.list.error === 'unauthorized' || model.list.error === 'not_configured'
            ? cloudSecretsErrorCopy(model.list.error, t)
            : t('cloudSecrets.list.loadFailed', 'Couldn’t load secrets.')
        }
        retryLabel={t('cloudSecrets.list.retry', 'Try again')}
        onRetry={model.reload}
      />
    )
  }

  const secrets = [...model.list.value].sort((a, b) => a.name.localeCompare(b.name))
  const actions =
    canWrite && mode.kind === 'idle' ? (
      <>
        <Button
          size="sm"
          data-action="add"
          onClick={() => setMode({ kind: 'edit', target: { kind: 'add' } })}
        >
          <Plus />
          {t('cloudSecrets.list.add', 'Add secret')}
        </Button>
        <Button
          variant="outline"
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
      <div className="flex min-h-8 items-center justify-between gap-3">
        {description ? (
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        ) : (
          <span />
        )}
        {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
      </div>
      {/* One status region that is always mounted, so saves are announced reliably. */}
      <p role="status" className="sr-only">
        {saved.size > 0
          ? t('cloudSecrets.list.savedAnnounce', 'Saved {{names}}', {
              names: [...saved].join(', ')
            })
          : ''}
      </p>
      {secrets.length === 0 && mode.kind === 'idle' ? (
        <div className="rounded-md border border-dashed border-border/60 px-4 py-5 text-center">
          <p className="text-sm font-medium">{emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
            {emptyDetail}
          </p>
          {emptyAction ? <div className="mt-3 flex justify-center">{emptyAction}</div> : null}
        </div>
      ) : secrets.length > 0 ? (
        <ul className="divide-y divide-border/60 rounded-md border border-border/60">
          {secrets.map((secret, index) =>
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
                    // The next row takes its place; else the previous one; else Add.
                    const neighbour = secrets[index + 1] ?? secrets[index - 1]
                    focusLater(
                      neighbour ? `[data-replace="${neighbour.name}"]` : '[data-action="add"]'
                    )
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
    </div>
  )
}
