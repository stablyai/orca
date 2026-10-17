import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type {
  DebugLaunchConfigListing,
  DebugLaunchTarget,
  DebugSnapshot
} from '../../../../preload/api/debug-api'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { debugClient, type DebugClient } from '@/lib/debug/debug-client'
import {
  onRunAndDebugRequest,
  takeRunAndDebugRequest,
  type DebugOpenRunAndDebugDetail
} from '@/lib/debug/debug-open-request'
import { resolveDebugEditorContext } from '@/lib/debug/debug-editor-context'
import {
  debugSessionStore,
  useDebugSession,
  type DebugSessionStore
} from '@/lib/debug/use-debug-session'
import {
  DebugConfigPicker,
  defaultDebugChoice,
  isSameDebugChoice,
  type DebugConfigChoice
} from './DebugConfigPicker'
import { DebugLaunchConfirm, useDebugLaunchFlow } from './DebugLaunchConfirm'
import { DebugToolbar, isDebugSessionLive } from './DebugToolbar'

type DebugPanelProps = {
  /** A function child gets core's realpath for the session, the only key the session store accepts. */
  children?: React.ReactNode | ((corePath: string) => React.ReactNode)
  client?: DebugClient
  store?: DebugSessionStore
}

type LaunchListing =
  | { status: 'loading' }
  /** The worktree cannot be debugged at all (SSH, remote runtime, no bridge). */
  | { status: 'refused'; message: string }
  | {
      status: 'ready'
      configs: DebugLaunchConfigListing[]
      launchError: string | null
      languages: string[]
    }

// launch.json itself is broken: show its error, never a fallback.
const LAUNCH_JSON_REFUSALS: readonly string[] = [
  'malformed',
  'unreadable',
  'compound',
  'unknown-type',
  'unsupported-request',
  'unsupported-variable'
]

function useLaunchListing(
  client: DebugClient,
  target: { repoId: string; worktreePath: string } | null,
  enabled: boolean
): LaunchListing {
  const [listing, setListing] = useState<LaunchListing>({ status: 'loading' })
  const repoId = target?.repoId ?? null
  const worktreePath = target?.worktreePath ?? null
  useEffect(() => {
    if (!repoId || !worktreePath) {
      return
    }
    let current = true
    setListing({ status: 'loading' })
    const params = { repoId, worktreePath }
    void Promise.all([client.listConfigs(params), client.describeAdapters(params)])
      .then(([configs, adapters]) => {
        if (!current) {
          return
        }
        const languages = adapters.ok ? adapters.value.flatMap((a) => a.languages) : []
        if (configs.ok) {
          setListing({
            status: 'ready',
            configs: configs.value,
            launchError: null,
            languages
          })
        } else if (configs.reason === 'not-found') {
          setListing({
            status: 'ready',
            configs: [],
            launchError: null,
            languages
          })
        } else if (LAUNCH_JSON_REFUSALS.includes(configs.reason)) {
          setListing({
            status: 'ready',
            configs: [],
            launchError: configs.message,
            languages
          })
        } else {
          setListing({ status: 'refused', message: configs.message })
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setListing({ status: 'refused', message: errorText(error) })
        }
      })
    return () => {
      current = false
    }
    // enabled re-lists after Allow, so a stale refusal does not linger.
  }, [client, repoId, worktreePath, enabled])
  return listing
}

export function DebugPanel({
  children,
  client = debugClient,
  store = debugSessionStore
}: DebugPanelProps): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const enabledRepos = useAppStore((s) => s.settings?.debugEnabledRepos)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const repos = useAppStore((s) => s.repos)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const activeFile = useAppStore((s) =>
    s.activeFileId ? (s.openFiles.find((file) => file.id === s.activeFileId) ?? null) : null
  )

  const context = useMemo(
    () => resolveDebugEditorContext({ worktreesByRepo }, activeWorktreeId ?? undefined, ''),
    [activeWorktreeId, worktreesByRepo]
  )
  // Keyed on the strings, not the context object: a worktree-list refresh rebuilds the
  // context, and a new target identity would re-fetch the snapshot and remount the sections.
  const targetRepoId = context?.repoId ?? null
  const targetPath = context?.rootPath ?? null
  const target = useMemo(
    () => (targetRepoId && targetPath ? { repoId: targetRepoId, worktreePath: targetPath } : null),
    [targetRepoId, targetPath]
  )
  const enabled = Boolean(context && enabledRepos?.includes(context.repoId))
  const listing = useLaunchListing(client, target, enabled)

  // Core keys sessions by the realpath it reports, which may differ from the renderer's path.
  const [corePath, setCorePath] = useState<string | null>(null)
  const session = useDebugSession(corePath, store)
  const snapshot = session.snapshot
  const live = isDebugSessionLive(snapshot)
  const [toolbarRefusal, setToolbarRefusal] = useState<string | null>(null)
  const [allowState, setAllowState] = useState<{ pending: boolean; error: string | null }>({
    pending: false,
    error: null
  })

  const onSnapshot = (next: DebugSnapshot): void => {
    store.ingestSnapshot(next)
    setCorePath(next.worktreePath)
  }
  const targetKey = target ? `${target.repoId}\0${target.worktreePath}` : null
  const flow = useDebugLaunchFlow(client, onSnapshot, targetKey)

  const [refusalKey, setRefusalKey] = useState(targetKey)
  if (refusalKey !== targetKey) {
    setRefusalKey(targetKey)
    setToolbarRefusal(null)
  }

  useEffect(() => {
    setCorePath(null)
    if (!target || !enabled) {
      return
    }
    let current = true
    client
      .snapshot(target)
      .then((result) => {
        if (!current) {
          return
        }
        if (result.ok) {
          store.ingestSnapshot(result.value)
          setCorePath(result.value.worktreePath)
        } else if (result.reason !== 'unavailable') {
          setToolbarRefusal(result.message)
        }
      })
      .catch((error: unknown) => current && setToolbarRefusal(errorText(error)))
    return () => {
      current = false
    }
  }, [client, store, target, enabled])

  const fileInWorktree =
    activeFile && activeFile.mode === 'edit' && activeFile.worktreeId === activeWorktreeId
      ? activeFile
      : null
  const ready = listing.status === 'ready' ? listing : null
  const currentFile =
    fileInWorktree && ready?.languages.includes(fileInWorktree.language)
      ? { name: fileInWorktree.relativePath || fileInWorktree.filePath }
      : null
  const configs = ready?.configs ?? []
  const [picked, setPicked] = useState<DebugConfigChoice | null>(null)
  const pickedValid =
    picked !== null &&
    (picked.kind === 'current-file'
      ? currentFile !== null
      : configs.some(
          (c) => c.runnable && isSameDebugChoice(picked, { kind: 'config', name: c.name })
        ))
  const choice = pickedValid ? picked : defaultDebugChoice(configs, currentFile)
  const choiceName = choice?.kind === 'config' ? choice.name : null

  // F5 starts the store's configName, keyed by core's path like every other store read.
  useEffect(() => {
    if (corePath !== null) {
      store.selectConfiguration(corePath, choiceName)
    }
  }, [store, corePath, choiceName])

  const fileParams = fileInWorktree
    ? { filePath: fileInWorktree.filePath, languageId: fileInWorktree.language }
    : {}
  const beginRef = useRef(flow.begin)
  beginRef.current = flow.begin
  const fileRef = useRef(fileParams)
  fileRef.current = fileParams
  // F5 opens this tab and asks for the confirmation; the request may predate this mount.
  useEffect(() => {
    if (!target || !enabled) {
      return
    }
    const handle = (detail: DebugOpenRunAndDebugDetail): void => {
      if (detail.message) {
        setToolbarRefusal(detail.message)
      } else if (detail.confirm && detail.configName) {
        setToolbarRefusal(null)
        void beginRef.current({ ...target, configName: detail.configName, ...fileRef.current })
      }
    }
    const early = takeRunAndDebugRequest()
    if (early) {
      handle(early)
    }
    return onRunAndDebugRequest(handle)
  }, [target, enabled])

  if (!context || !target) {
    return (
      <Message
        text={translate('debug.panel.noWorkspace', 'Open a workspace to run and debug it.')}
      />
    )
  }
  if (listing.status === 'refused') {
    return <Message text={listing.message} />
  }
  if (!enabled) {
    const allow = async (): Promise<void> => {
      const others = (enabledRepos ?? []).filter((id) => id !== context.repoId)
      setAllowState({ pending: true, error: null })
      try {
        await updateSettings({ debugEnabledRepos: [...others, context.repoId] })
        setAllowState({ pending: false, error: null })
      } catch (error) {
        setAllowState({ pending: false, error: errorText(error) })
      }
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <p>
          {translate(
            'debug.off.description',
            'Debugging is off for this repository. Allowing it lets Orca start the debug adapters you confirm.'
          )}
        </p>
        <Button size="sm" disabled={allowState.pending} onClick={() => void allow()}>
          {translate('debug.off.allow', 'Allow debugging for this repository')}
        </Button>
        {allowState.error ? (
          <p role="alert" className="text-xs break-words text-destructive">
            {translate('debug.off.allowFailed', 'Could not save the setting: {{error}}', {
              error: allowState.error
            })}
          </p>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            openSettingsTarget({ pane: 'general', repoId: null })
            openSettingsPage()
          }}
        >
          {translate('debug.off.openSettings', 'Open Settings')}
        </Button>
      </div>
    )
  }

  const repoNameOf = (repoId: string): string =>
    repos?.find((repo) => repo.id === repoId)?.displayName ?? repoId
  const startTarget = (): DebugLaunchTarget | null => {
    if (!choice) {
      return null
    }
    return choice.kind === 'config'
      ? { ...target, configName: choice.name, ...fileParams }
      : { ...target, ...fileParams }
  }
  const refusal = flow.refusal ?? toolbarRefusal ?? (live ? null : (snapshot?.lastError ?? null))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek">
      {live && snapshot ? (
        <>
          <DebugToolbar
            client={client}
            target={target}
            snapshot={snapshot}
            selectedThreadId={session.selectedThreadId}
            onSnapshot={onSnapshot}
            onRefusal={setToolbarRefusal}
          />
          {snapshot.configName ? (
            <div className="truncate px-3 py-1 text-xs text-muted-foreground">
              {snapshot.configName}
            </div>
          ) : null}
        </>
      ) : listing.status === 'loading' ? (
        <Message text={translate('debug.panel.loading', 'Loading launch configurations…')} />
      ) : (
        <>
          <DebugConfigPicker
            configs={configs}
            launchError={listing.launchError}
            currentFile={currentFile}
            selected={choice}
            onSelect={setPicked}
          />
          {listing.launchError || flow.pending ? null : (
            <div className="px-3 py-1">
              <Button
                size="sm"
                disabled={!choice || flow.busy}
                onClick={() => {
                  const next = startTarget()
                  if (next) {
                    setToolbarRefusal(null)
                    void flow.begin(next)
                  }
                }}
              >
                <Play />
                {translate('debug.panel.start', 'Start Debugging')}
              </Button>
            </div>
          )}
        </>
      )}
      {flow.pending ? (
        <DebugLaunchConfirm
          pending={flow.pending}
          repoName={repoNameOf(flow.pending.target.repoId)}
          busy={flow.busy}
          onConfirm={() => void flow.confirm()}
          onCancel={flow.cancel}
        />
      ) : null}
      {refusal ? (
        <div role="alert" className="px-3 py-1 text-xs break-words text-destructive">
          {refusal}
        </div>
      ) : null}
      {typeof children === 'function' ? (corePath === null ? null : children(corePath)) : children}
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Message({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}
