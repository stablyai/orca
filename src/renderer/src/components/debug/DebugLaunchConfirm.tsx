import type React from 'react'
import { useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type {
  DebugLaunchPreview,
  DebugLaunchRunsWire,
  DebugLaunchTarget,
  DebugSnapshot
} from '../../../../preload/api/debug-api'
import type { DebugClient } from '@/lib/debug/debug-client'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type LaunchClient = Pick<DebugClient, 'previewLaunch' | 'approveLaunch' | 'start'>

export type PendingDebugLaunch = {
  target: DebugLaunchTarget
  preview: DebugLaunchPreview
  /** Set when the config or adapter changed after an earlier preview. */
  changed: boolean
}

/** preview → (confirm → approve) → start, every step bound to previewLaunch's expectedHash. */
export function useDebugLaunchFlow(
  client: LaunchClient,
  onStarted: (snapshot: DebugSnapshot) => void,
  /** Identifies the repo and worktree; a change drops any pending confirmation. */
  targetKey: string | null = null
) {
  const [pending, setPending] = useState<PendingDebugLaunch | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Why: a reply for a launch the user already cancelled or replaced must not act.
  const generation = useRef(0)

  // A confirmation approves pending.target; left open after a switch, it would run the old workspace.
  const [seenKey, setSeenKey] = useState(targetKey)
  if (seenKey !== targetKey) {
    setSeenKey(targetKey)
    generation.current++
    setPending(null)
    setRefusal(null)
    setBusy(false)
  }

  async function run(step: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const mine = ++generation.current
    const isCurrent = (): boolean => mine === generation.current
    setBusy(true)
    setRefusal(null)
    try {
      await step(isCurrent)
    } catch (error) {
      if (isCurrent()) {
        setPending(null)
        setRefusal(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (isCurrent()) {
        setBusy(false)
      }
    }
  }

  async function previewThenStart(
    target: DebugLaunchTarget,
    changed: boolean,
    isCurrent: () => boolean
  ): Promise<void> {
    const preview = await client.previewLaunch(target)
    if (!isCurrent()) {
      return
    }
    if (!preview.ok) {
      setPending(null)
      setRefusal(preview.message)
      return
    }
    const { approved, expectedHash } = preview.value
    // A changed launch is always shown again, even when both keys are already approved.
    if (!changed && approved.adapter && approved.launch) {
      await startWith(target, expectedHash, isCurrent)
      return
    }
    setPending({ target, preview: preview.value, changed })
  }

  async function startWith(
    target: DebugLaunchTarget,
    expectedHash: string,
    isCurrent: () => boolean
  ): Promise<void> {
    const started = await client.start({ ...target, expectedHash })
    if (!isCurrent()) {
      return
    }
    if (started.ok) {
      onStarted(started.value)
    } else if (started.reason === 'changed-since-preview') {
      await previewThenStart(target, true, isCurrent)
    } else {
      setRefusal(started.message)
    }
  }

  const begin = (target: DebugLaunchTarget): Promise<void> =>
    run((isCurrent) => previewThenStart(target, false, isCurrent))

  const confirm = (): Promise<void> => {
    if (!pending) {
      return Promise.resolve()
    }
    const { target, preview } = pending
    return run(async (isCurrent) => {
      const approved = await client.approveLaunch({
        ...target,
        expectedHash: preview.expectedHash
      })
      if (!isCurrent()) {
        return
      }
      if (!approved.ok) {
        if (approved.reason === 'changed-since-preview') {
          await previewThenStart(target, true, isCurrent)
        } else {
          setPending(null)
          setRefusal(approved.message)
        }
        return
      }
      setPending(null)
      await startWith(target, preview.expectedHash, isCurrent)
    })
  }

  const cancel = (): void => {
    generation.current++
    setPending(null)
    setBusy(false)
  }

  return {
    pending,
    refusal,
    busy,
    begin,
    confirm,
    cancel,
    clearRefusal: () => setRefusal(null)
  }
}

// Bidi and zero-width controls can make shown text differ from what runs, so they print escaped.
const INVISIBLE_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

function escapeInvisible(text: string): string {
  return text.replace(
    INVISIBLE_CONTROLS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

export function formatRunValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  if (typeof value === 'string') {
    return escapeInvisible(value)
  }
  if (Array.isArray(value)) {
    // Quoted, so ["--x y"] and ["--x", "y"] read differently and newlines show as \n.
    return value.length === 0
      ? null
      : escapeInvisible(value.map((item) => JSON.stringify(item)).join(' '))
  }
  return escapeInvisible(typeof value === 'object' ? JSON.stringify(value) : String(value))
}

type RunsKeyEntry = { name: string; value: string; dangerous: boolean }
type RunsEnvEntry = DebugLaunchRunsWire['env'][number]

const isKeyEntry = (v: unknown): v is RunsKeyEntry =>
  typeof v === 'object' && v !== null && 'name' in v && 'value' in v && 'dangerous' in v
const isEnvEntry = (v: unknown): v is RunsEnvEntry => isKeyEntry(v) && 'masked' in v

/** Core's allKeys and envFileEntries, with malformed entries dropped rather than rendered. */
function extraRuns(runs: DebugLaunchRunsWire): {
  allKeys: RunsKeyEntry[]
  envFileEntries: RunsEnvEntry[]
} {
  const allKeys = Array.isArray(runs.allKeys) ? runs.allKeys : []
  const envFile = Array.isArray(runs.envFileEntries) ? runs.envFileEntries : []
  return { allKeys: allKeys.filter(isKeyEntry), envFileEntries: envFile.filter(isEnvEntry) }
}

type DebugLaunchConfirmProps = {
  pending: PendingDebugLaunch
  /** The repo's display name; with pending.target.worktreePath it names where this runs. */
  repoName: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function DebugLaunchConfirm({
  pending,
  repoName,
  busy,
  onConfirm,
  onCancel
}: DebugLaunchConfirmProps): React.JSX.Element {
  const { preview, changed, target } = pending
  const { runs } = preview
  const { allKeys, envFileEntries } = extraRuns(runs)
  const rows: [string, unknown][] = [
    [translate('debug.confirm.workspace', 'Workspace'), `${repoName} — ${target.worktreePath}`],
    // The adapter bound into expectedHash and spawned, not a second resolution.
    [
      translate('debug.confirm.adapter', 'Adapter'),
      [preview.adapter.binaryPath, ...preview.adapter.args]
    ],
    [translate('debug.confirm.program', 'Program'), runs.program],
    [translate('debug.confirm.module', 'Module'), runs.module],
    [translate('debug.confirm.python', 'Python'), runs.python],
    [translate('debug.confirm.runtimeExecutable', 'Runtime'), runs.runtimeExecutable],
    [translate('debug.confirm.runtimeArgs', 'Runtime args'), runs.runtimeArgs],
    [translate('debug.confirm.args', 'Args'), runs.args],
    [translate('debug.confirm.cwd', 'Working directory'), runs.cwd],
    [translate('debug.confirm.envFile', 'Env file'), runs.envFile],
    [translate('debug.confirm.processId', 'Process ID'), runs.processId],
    [translate('debug.confirm.host', 'Host'), runs.host],
    [translate('debug.confirm.port', 'Port'), runs.port]
  ]

  return (
    <section
      role="dialog"
      aria-label={translate('debug.confirm.title', 'Confirm debug launch')}
      className="m-2 flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-xs"
    >
      <div className="text-sm font-medium">
        {translate('debug.confirm.heading', 'Run “{{name}}”?', {
          name: preview.name
        })}
      </div>
      <p className="text-muted-foreground">
        {translate(
          'debug.confirm.description',
          'Starting this runs the commands below on this machine.'
        )}
      </p>
      {changed ? (
        <Warning
          text={translate(
            'debug.confirm.changed',
            'This configuration or its adapter changed since you last looked. Review it again.'
          )}
        />
      ) : null}
      {preview.adapter.repoLocal ? (
        <Warning
          text={translate(
            'debug.confirm.repoLocal',
            'The adapter binary is inside this repository; anything that can write the repo can change what runs.'
          )}
        />
      ) : null}
      {preview.consoleForcedFrom ? (
        <p className="text-muted-foreground">
          {translate(
            'debug.confirm.consoleForced',
            'Console “{{from}}” is not supported; output goes to the Debug Console.',
            { from: preview.consoleForcedFrom }
          )}
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => {
          const text = formatRunValue(value)
          return text === null ? null : (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono break-all">{text}</dd>
            </div>
          )
        })}
      </dl>
      <EnvList title={translate('debug.confirm.env', 'Environment')} entries={runs.env} />
      <EnvList
        title={translate('debug.confirm.envFileEntries', 'Env file contents')}
        entries={envFileEntries}
      />
      {allKeys.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground">
            {translate('debug.confirm.allKeys', 'Everything the adapter receives')}
          </div>
          <ul className="flex flex-col gap-0.5">
            {allKeys.map((entry) => (
              <li
                key={entry.name}
                data-dangerous={entry.dangerous || undefined}
                className="flex items-start gap-1.5 font-mono break-all data-[dangerous]:text-status-warning"
              >
                {entry.dangerous ? (
                  <TriangleAlert
                    className="mt-0.5 size-3 shrink-0"
                    aria-label={translate(
                      'debug.confirm.dangerousKey',
                      'Runs commands or binaries'
                    )}
                  />
                ) : null}
                <span className="shrink-0">{entry.name}</span>
                <span className="text-muted-foreground">= {escapeInvisible(entry.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {translate('debug.confirm.cancel', 'Cancel')}
        </Button>
        <Button size="sm" disabled={busy} onClick={onConfirm}>
          {translate('debug.confirm.start', 'Start')}
        </Button>
      </div>
    </section>
  )
}

function EnvList({
  title,
  entries
}: {
  title: string
  entries: RunsEnvEntry[]
}): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="text-muted-foreground">{title}</div>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => (
          <li key={entry.name} className="flex items-center gap-1.5 font-mono break-all">
            {entry.dangerous ? (
              <TriangleAlert
                className="size-3 shrink-0 text-status-warning"
                aria-label={translate(
                  'debug.confirm.dangerousEnv',
                  'Changes how programs load code'
                )}
              />
            ) : null}
            <span>{entry.name}</span>
            <span className="text-muted-foreground">
              {entry.masked
                ? translate('debug.confirm.masked', '(masked)')
                : `= ${escapeInvisible(entry.value ?? '')}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Warning({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-status-warning-border bg-status-warning-background px-2 py-1.5 text-status-warning">
      <TriangleAlert className="mt-0.5 size-3 shrink-0" />
      <span>{text}</span>
    </div>
  )
}
