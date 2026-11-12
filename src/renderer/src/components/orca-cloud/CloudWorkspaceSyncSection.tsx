// The card's "On this computer" sub-panel: `.context` sync (on by default) and the read-only mirror
// (off by default); with the mirror on, where the files are and how current they are. Quiet by
// design: no toasts; progress is announced politely and at most every ~10 s.
import React, { useContext, useEffect, useId, useRef, useState } from 'react'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { Copy, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Switch } from '@/components/ui/switch'
import { useNow } from '@/hooks/use-now'
import { getIntlLocale } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  openCloudSyncFolder,
  retryCloudSync,
  setCloudSyncChoice,
  takeCloudSyncFocus,
  useCloudSync,
  useCloudSyncFocusRequest
} from '@/lib/orca-cloud/cloud-sync-store'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'

const ANNOUNCE_EVERY_MS = 10_000
const JUST_NOW_MS = 60_000

type T = ReturnType<typeof useTranslate>

function formatCount(value: number): string {
  return new Intl.NumberFormat(getIntlLocale()).format(value)
}

/** Round sizes for prose and the status line ("2 GB", "1.4 GB", "38 MB", "640 KB"). */
export function syncSize(t: T, bytes: number): string {
  const format = (value: number, digits: number): string =>
    new Intl.NumberFormat(getIntlLocale(), { maximumFractionDigits: digits }).format(value)
  if (bytes >= 1e9) {
    return t('orcaCloudSync.gb', '{{value}} GB', { value: format(bytes / 1e9, 1) })
  }
  if (bytes >= 1e6) {
    return t('orcaCloudSync.mb', '{{value}} MB', { value: format(bytes / 1e6, 0) })
  }
  return t('orcaCloudSync.kb', '{{value}} KB', {
    value: format(Math.max(bytes > 0 ? 1 : 0, bytes / 1e3), 0)
  })
}

/** Breaks a path only after "/", so folder names stay whole when it wraps. */
function PathWithBreaks({ path }: { path: string }): React.JSX.Element {
  const parts = path.split('/')
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 ? (
            <>
              /<wbr />
            </>
          ) : null}
        </React.Fragment>
      ))}
    </>
  )
}

function ago(t: T, at: number, now: number): string {
  const minutes = Math.floor((now - at) / JUST_NOW_MS)
  if (minutes < 1) {
    return t('orcaCloudSync.justNow', 'just now')
  }
  // Whole minutes, then whole hours: a status line that ticks seconds reads as noise.
  return minutes < 60
    ? t('orcaCloudSync.minutesAgo', '{{count}} min ago', { count: minutes })
    : t('orcaCloudSync.hoursAgo', '{{count}} h ago', { count: Math.floor(minutes / 60) })
}

/** The status line under the switches. */
export function cloudSyncStatusLine(view: CloudSyncView, t: T, now: number): string | null {
  if (view.phase === 'off') {
    return null
  }
  if (view.phase === 'copying' && view.progress) {
    return t('orcaCloudSync.copying', 'Copying {{done}} of {{total}} files…', {
      done: formatCount(view.progress.done),
      total: formatCount(view.progress.total)
    })
  }
  if (view.phase === 'waiting') {
    return view.lastSyncedAt
      ? t('orcaCloudSync.waitingSynced', 'Waits until the workspace wakes · synced {{ago}}', {
          ago: ago(t, view.lastSyncedAt, now)
        })
      : t('orcaCloudSync.waiting', 'Waits until the workspace wakes')
  }
  if (view.phase === 'starting' || (view.phase === 'copying' && !view.progress)) {
    return t('orcaCloudSync.syncing', 'Syncing…')
  }
  if (view.phase === 'synced' && view.lastSyncedAt && view.files === 0) {
    // Nothing to copy yet: "0 files · 0 KB" reads like a fault.
    return t('orcaCloudSync.syncedEmpty', 'Synced · {{ago}}', {
      ago: ago(t, view.lastSyncedAt, now)
    })
  }
  if (view.phase === 'synced' && view.lastSyncedAt) {
    const values = {
      files: t('orcaCloudSync.fileCount', '{{n}} files', {
        count: view.files,
        n: formatCount(view.files),
        defaultValue_one: '{{n}} file'
      }),
      size: syncSize(t, view.bytes),
      ago: ago(t, view.lastSyncedAt, now)
    }
    // The cap was hit: say so instead of claiming a full copy.
    return view.overLimit > 0
      ? t(
          'orcaCloudSync.syncedToLimit',
          'Synced up to the limit · {{files}} · {{size}} · {{ago}}',
          values
        )
      : t('orcaCloudSync.synced', 'Synced · {{files}} · {{size}} · {{ago}}', values)
  }
  return null
}

function SyncRow({
  label,
  description,
  checked,
  onCheckedChange,
  switchRef
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (next: boolean) => void
  switchRef?: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={`${id}-switch`} className="block font-medium text-foreground">
          {label}
        </label>
        <p id={`${id}-desc`} className="mt-0.5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        ref={switchRef}
        id={`${id}-switch`}
        aria-describedby={`${id}-desc`}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
    </div>
  )
}

/** Polite, throttled announcements: progress at most every ~10 s; done and errors at once. */
function useAnnouncement(view: CloudSyncView | null, t: T): string {
  const [message, setMessage] = useState('')
  const lastAt = useRef(0)
  const lastPhase = useRef<string | null>(null)
  useEffect(() => {
    if (!view) {
      return
    }
    const phaseChanged = lastPhase.current !== view.phase
    lastPhase.current = view.phase
    const now = Date.now()
    if (view.phase === 'copying' && view.progress) {
      if (now - lastAt.current >= ANNOUNCE_EVERY_MS) {
        lastAt.current = now
        setMessage(cloudSyncStatusLine(view, t, now) ?? '')
      }
    } else if (phaseChanged && view.phase === 'synced') {
      lastAt.current = 0
      setMessage(t('orcaCloudSync.announceSynced', 'Files synced to this computer'))
    } else if (phaseChanged && view.phase === 'error') {
      setMessage(t('orcaCloudSync.error', 'Couldn’t sync files. Your files in the cloud are safe.'))
    }
  }, [view, t])
  return message
}

export function CloudWorkspaceSyncSection({
  workspaceId,
  view: injected,
  labelledBy
}: {
  workspaceId: string
  /** Fixtures pass a view; the panel reads the live one. */
  view?: CloudSyncView | null
  /** The sub-panel's heading. */
  labelledBy: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const live = useCloudSync(workspaceId)
  const view = injected === undefined ? live : injected
  const now = useNow(30_000)
  const section = useRef<HTMLElement | null>(null)
  const mirrorSwitch = useRef<HTMLButtonElement | null>(null)
  const focusRequested = useCloudSyncFocusRequest(workspaceId)
  const [copied, setCopied] = useState(false)
  const announcement = useAnnouncement(view, t)
  const confirm = useContext(ConfirmationDialogContext)

  /** Turning a row off removes copies; changed ones are only removed after asking (as archive/delete). */
  const choose = async (patch: { context?: boolean; mirror?: boolean }): Promise<void> => {
    if (!view) {
      return
    }
    const next = { ...view.choice, ...patch }
    const removes = (view.choice.mirror && !next.mirror) || (!next.context && !next.mirror)
    if (removes && view.editedHere > 0 && confirm) {
      const ok = await confirm({
        title: t('orcaCloudSync.removeConfirmTitle', 'Remove the copy on this computer?'),
        description: t(
          'orcaCloudSync.removalEdited',
          '{{count}} changed files on this computer will be removed.',
          {
            count: view.editedHere,
            defaultValue_one: '{{count}} changed file on this computer will be removed.'
          }
        ),
        confirmLabel: t('orcaCloudSync.removeCopy', 'Remove copy'),
        confirmVariant: 'destructive',
        initialFocus: 'cancel'
      })
      if (!ok) {
        return
      }
    }
    await setCloudSyncChoice(workspaceId, patch)
  }

  useEffect(() => {
    if (!focusRequested || !view) {
      return
    }
    // After the popover's own open-focus, which runs once this effect has.
    const frame = requestAnimationFrame(() => {
      if (takeCloudSyncFocus(workspaceId)) {
        section.current?.scrollIntoView({ block: 'nearest' })
        mirrorSwitch.current?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRequested, view, workspaceId])

  if (!view) {
    return null
  }
  const on = view.choice.context || view.choice.mirror
  const mirror = view.choice.mirror
  const status = cloudSyncStatusLine(view, t, now)
  const tooLarge = view.skippedLarge > 0
  const overLimit = view.overLimit > 0

  return (
    <section
      ref={section}
      aria-labelledby={labelledBy}
      className="flex flex-col gap-2.5"
      data-cloud-sync-section={workspaceId}
    >
      <SyncRow
        label={t('orcaCloudSync.contextLabel', '.context folder')}
        description={t(
          'orcaCloudSync.contextHelper',
          'Plans and screenshots from this workspace, synced to this computer.'
        )}
        checked={view.choice.context}
        onCheckedChange={(next) => void choose({ context: next })}
      />
      {on && !mirror && status ? (
        <p className="-mt-1 tabular-nums text-muted-foreground" data-cloud-sync-status="context">
          {status}
        </p>
      ) : null}
      <SyncRow
        switchRef={mirrorSwitch}
        label={t('orcaCloudSync.mirrorLabel', 'Mirror to this computer')}
        description={t(
          'orcaCloudSync.mirrorHelper',
          'A read-only copy of this workspace’s files, kept up to date while it runs.'
        )}
        checked={view.choice.mirror}
        onCheckedChange={(next) => void choose({ mirror: next })}
      />

      {mirror && status ? (
        <p className="-mt-1 tabular-nums text-muted-foreground" data-cloud-sync-status="mirror">
          {status}
        </p>
      ) : null}
      {mirror ? (
        <div className="flex flex-col gap-1.5">
          <code
            className="block min-w-0 break-words rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            title={view.displayPath}
            data-cloud-sync-path
          >
            <PathWithBreaks path={view.displayPath} />
          </code>
          <div className="-ml-2 flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => void openCloudSyncFolder(workspaceId)}
            >
              <FolderOpen />
              {t('orcaCloudSync.openFolder', 'Open folder')}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => {
                void navigator.clipboard.writeText(view.openPath).then(() => setCopied(true))
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              <Copy />
              {copied
                ? t('orcaCloudSync.copied', 'Copied')
                : t('orcaCloudSync.copyPath', 'Copy path')}
            </Button>
          </div>
        </div>
      ) : null}

      {on && view.phase === 'error' ? (
        <InlineError
          title={t('orcaCloudSync.error', 'Couldn’t sync files. Your files in the cloud are safe.')}
          retryLabel={t('orcaCloudSync.tryAgain', 'Try again')}
          onRetry={() => void retryCloudSync(workspaceId)}
          density="compact"
        />
      ) : null}
      {on && view.editedHere > 0 ? (
        <InlineError
          tone="neutral"
          density="compact"
          title={t(
            'orcaCloudSync.editedHere',
            '{{count}} files changed on this computer. Edits here don’t sync back. The cloud copy replaces them when it changes.',
            {
              count: view.editedHere,
              defaultValue_one:
                '{{count}} file changed on this computer. Edits here don’t sync back. The cloud copy replaces it when it changes.'
            }
          )}
        />
      ) : null}
      {on && (tooLarge || overLimit) ? (
        <InlineError
          tone="neutral"
          density="compact"
          title={
            overLimit
              ? t(
                  'orcaCloudSync.overLimit',
                  'The mirror is limited to {{size}}. Larger files and anything past the limit aren’t copied.',
                  { size: syncSize(t, view.limits.maxBytes) }
                )
              : t('orcaCloudSync.tooLarge', 'Files over {{size}} aren’t copied.', {
                  size: syncSize(t, view.limits.maxFileBytes)
                })
          }
        />
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </section>
  )
}
