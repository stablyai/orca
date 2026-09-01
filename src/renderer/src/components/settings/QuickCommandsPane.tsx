import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { searchTerminalQuickCommands } from '@/lib/terminal-quick-command-search'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { deleteTerminalQuickCommand, saveTerminalQuickCommand } from '@/lib/agent-catalog-authoring'
import {
  AgentAuthoringWriteFailureNotice,
  asAgentAuthoringWriteFailure
} from './agent-authoring-write-failure'
import { getSettingOwnershipSummary } from './setting-ownership'
import { translate } from '@/i18n/i18n'
import { QuickCommandsList } from './QuickCommandsList'
import { QuickCommandsToolbar } from './QuickCommandsToolbar'
import { GLOBAL_SCOPE_KEY } from './QuickCommandsScopeFilter'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  getAvailableQuickCommandHostId,
  isQuickCommandEditorHostCurrent,
  shouldOpenQuickCommandAddIntent,
  shouldShowQuickCommandsRefreshError
} from './quick-commands-pane-host-state'
import {
  getTerminalQuickCommandHostOptions,
  shouldShowTerminalQuickCommandHostOwnership
} from '@/hooks/use-terminal-quick-command-hosts'

type QuickCommandsPaneProps = {
  settings: GlobalSettings
  addCommandIntentSignal?: number
}

type EditorState =
  | {
      mode: 'add'
      command: TerminalQuickCommand
      connectionGeneration: number
      hostId: ExecutionHostId
    }
  | {
      mode: 'edit'
      command: TerminalQuickCommand
      connectionGeneration: number
      hostId: ExecutionHostId
    }
  | null

export function QuickCommandsPane({
  settings,
  addCommandIntentSignal
}: QuickCommandsPaneProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatuses = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const runtimeCommands = useAppStore((s) => s.runtimeTerminalQuickCommands)
  const loadRuntimeCommands = useAppStore((s) => s.loadRuntimeTerminalQuickCommands)
  const ownership = getSettingOwnershipSummary('terminalQuickCommands')
  const confirm = useConfirmationDialog()
  const [selectedHostId, setSelectedHostId] = useState<ExecutionHostId>(LOCAL_EXECUTION_HOST_ID)
  const selectedHost = parseExecutionHostId(selectedHostId)
  const selectedEnvironmentId = selectedHost?.kind === 'runtime' ? selectedHost.environmentId : null
  const selectedRuntimeConnectionGeneration = selectedEnvironmentId
    ? (runtimeStatuses.get(selectedEnvironmentId)?.connectionGeneration ?? 0)
    : 0
  const selectedRuntimeCommands = selectedEnvironmentId
    ? runtimeCommands.get(selectedEnvironmentId)
    : undefined
  const selectedRuntimeCommandsAreCurrent =
    selectedRuntimeCommands?.connectionGeneration === selectedRuntimeConnectionGeneration
  const commands = selectedEnvironmentId
    ? selectedRuntimeCommandsAreCurrent
      ? (selectedRuntimeCommands?.commands ?? [])
      : []
    : (settings.terminalQuickCommands ?? [])
  const canManageSelectedHost =
    !selectedEnvironmentId ||
    (selectedRuntimeCommandsAreCurrent && selectedRuntimeCommands?.supported === true)

  useEffect(() => {
    if (selectedEnvironmentId) {
      void loadRuntimeCommands(selectedEnvironmentId, { force: true })
    }
  }, [loadRuntimeCommands, selectedEnvironmentId, selectedRuntimeConnectionGeneration])

  const hostOptions = getTerminalQuickCommandHostOptions(settings, runtimeEnvironments)

  const [editor, setEditor] = useState<EditorState>(null)
  const consumedAddIntentSignalRef = useRef(0)
  // Why: `null` means "show all" (sticky-all), independent of the current repo
  // list — mirrors the tasks-page repo combobox so newly added repos appear
  // automatically rather than being silently excluded.
  const [scopeSelection, setScopeSelection] = useState<ReadonlySet<string> | null>(null)
  const [scopePopoverOpen, setScopePopoverOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Why: the dialog closes on save, so a durable-write rejection would otherwise
  // read as saved until the edit vanishes on the next launch.
  const [writeFailed, setWriteFailed] = useState(false)
  const surfaceMutationOutcome = (result: { ok: boolean }): void => {
    setWriteFailed(asAgentAuthoringWriteFailure(result) !== null)
  }

  const availableHostId = getAvailableQuickCommandHostId(selectedHostId, hostOptions)
  const editorHostIsCurrent =
    editor === null ||
    isQuickCommandEditorHostCurrent(
      editor.hostId,
      editor.connectionGeneration,
      hostOptions,
      runtimeStatuses
    )
  if (availableHostId !== selectedHostId) {
    setSelectedHostId(availableHostId)
    setScopeSelection(null)
  }
  if (!editorHostIsCurrent) {
    setEditor(null)
  }

  const hostRepos = useMemo(
    () =>
      selectedEnvironmentId
        ? repos.filter((repo) => getRepoExecutionHostId(repo) === selectedHostId)
        : repos,
    [repos, selectedEnvironmentId, selectedHostId]
  )
  const repoById = useMemo(() => new Map(hostRepos.map((repo) => [repo.id, repo])), [hostRepos])

  const allScopeKeys = useMemo(
    () => new Set<string>([GLOBAL_SCOPE_KEY, ...hostRepos.map((repo) => repo.id)]),
    [hostRepos]
  )
  const effectiveSelection: ReadonlySet<string> = scopeSelection ?? allScopeKeys
  const showAll = scopeSelection === null

  const scopedCommands = commands.filter((command) => {
    const scope = getTerminalQuickCommandScope(command)
    if (showAll) {
      return true
    }
    if (scope.type === 'global') {
      return effectiveSelection.has(GLOBAL_SCOPE_KEY)
    }
    return effectiveSelection.has(scope.repoId)
  })
  const visibleCommands = searchTerminalQuickCommands(scopedCommands, query)

  const createDraftForCurrentFilter = useCallback((): TerminalQuickCommand => {
    // Why: when the user has narrowed to a single repo scope, the natural
    // intent for "Add Command" is to create one in that repo. When the filter
    // is narrowed to Global-only, honor that. Otherwise prefer the active
    // workspace repo; fall back to global when there's no active repo.
    if (!showAll) {
      const selectedRepoIds = [...effectiveSelection].filter((key) => key !== GLOBAL_SCOPE_KEY)
      if (selectedRepoIds.length === 1 && !effectiveSelection.has(GLOBAL_SCOPE_KEY)) {
        return createTerminalQuickCommandDraft({ type: 'repo', repoId: selectedRepoIds[0] })
      }
      if (selectedRepoIds.length === 0 && effectiveSelection.has(GLOBAL_SCOPE_KEY)) {
        return createTerminalQuickCommandDraft({ type: 'global' })
      }
    }
    if (activeRepoId && repoById.has(activeRepoId)) {
      return createTerminalQuickCommandDraft({ type: 'repo', repoId: activeRepoId })
    }
    return createTerminalQuickCommandDraft({ type: 'global' })
  }, [activeRepoId, effectiveSelection, repoById, showAll])

  const intentSignal = addCommandIntentSignal
  if (
    typeof intentSignal === 'number' &&
    shouldOpenQuickCommandAddIntent(intentSignal, consumedAddIntentSignalRef.current)
  ) {
    // Why: Settings deep-links use this one-shot signal to open the add dialog;
    // consume it before paint so the pane never flashes without the editor.
    consumedAddIntentSignalRef.current = intentSignal
    setEditor({
      mode: 'add',
      command: createDraftForCurrentFilter(),
      connectionGeneration: selectedRuntimeConnectionGeneration,
      hostId: selectedHostId
    })
  }

  const toggleScope = (key: string): void => {
    const current = new Set(effectiveSelection)
    if (current.has(key)) {
      // Why: forbid the empty selection — every command would disappear and
      // there'd be no signal that the filter caused it.
      if (current.size <= 1) {
        return
      }
      current.delete(key)
    } else {
      current.add(key)
    }
    setScopeSelection(current.size === allScopeKeys.size ? null : current)
  }

  const handleSelectAll = (): void => {
    if (showAll) {
      // Why: tasks-page parity — clicking "All" while everything is selected
      // collapses to a single scope rather than emitting an empty set.
      setScopeSelection(new Set([GLOBAL_SCOPE_KEY]))
      return
    }
    setScopeSelection(null)
  }

  const saveCommand = (next: TerminalQuickCommand): void => {
    if (
      !editor ||
      !isQuickCommandEditorHostCurrent(
        editor.hostId,
        editor.connectionGeneration,
        hostOptions,
        runtimeStatuses
      )
    ) {
      setEditor(null)
      return
    }
    useAppStore.getState().recordFeatureInteraction('quick-commands')
    if (editor.hostId.startsWith('runtime:')) {
      void useAppStore.getState().upsertTerminalQuickCommand(editor.hostId, next)
      return
    }
    void saveTerminalQuickCommand(next).then(surfaceMutationOutcome)
  }

  const removeCommand = async (command: TerminalQuickCommand): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.settings.QuickCommandsPane.3edf3deaf8',
        'Delete "{{value0}}"?',
        { value0: command.label || 'Untitled' }
      ),
      description: translate(
        'auto.components.settings.QuickCommandsPane.3d9dc558e8',
        'This quick command will be removed from your saved list.'
      ),
      confirmLabel: translate('auto.components.settings.QuickCommandsPane.ec1ed99e70', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    if (selectedHostId.startsWith('runtime:')) {
      void useAppStore.getState().deleteTerminalQuickCommand(selectedHostId, command.id)
      return
    }
    void deleteTerminalQuickCommand(command.id).then(surfaceMutationOutcome)
  }

  const openAddDialog = (): void =>
    setEditor({
      mode: 'add',
      command: createDraftForCurrentFilter(),
      connectionGeneration: selectedRuntimeConnectionGeneration,
      hostId: selectedHostId
    })

  return (
    <div className="space-y-4">
      {writeFailed ? <AgentAuthoringWriteFailureNotice /> : null}
      {shouldShowTerminalQuickCommandHostOwnership(hostOptions) ? (
        <p className="text-xs text-muted-foreground">{ownership.description}</p>
      ) : null}

      <QuickCommandsToolbar
        query={query}
        setQuery={setQuery}
        hostOptions={hostOptions}
        showHostSelect={shouldShowTerminalQuickCommandHostOwnership(hostOptions)}
        selectedHostId={selectedHostId}
        onHostChange={(hostId) => {
          setSelectedHostId(hostId)
          setScopeSelection(null)
        }}
        canAdd={canManageSelectedHost}
        onAdd={openAddDialog}
        repos={hostRepos}
        effectiveSelection={effectiveSelection}
        showAll={showAll}
        scopePopoverOpen={scopePopoverOpen}
        setScopePopoverOpen={setScopePopoverOpen}
        handleSelectAll={handleSelectAll}
        toggleScope={toggleScope}
      />

      {selectedRuntimeCommandsAreCurrent && selectedRuntimeCommands?.supported === false ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.QuickCommandsPane.d59bd333c3',
            'Update this Orca server to manage its quick commands.'
          )}
        </div>
      ) : selectedRuntimeCommandsAreCurrent &&
        selectedRuntimeCommands?.error &&
        !selectedRuntimeCommands.ready ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3">
          <span className="text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.QuickCommandsPane.f2bf411640',
              'Could not load commands from this host.'
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() =>
              selectedEnvironmentId &&
              void loadRuntimeCommands(selectedEnvironmentId, { force: true })
            }
          >
            {translate('auto.components.settings.QuickCommandsPane.7ecfee5b8e', 'Retry')}
          </Button>
        </div>
      ) : selectedEnvironmentId &&
        (!selectedRuntimeCommandsAreCurrent ||
          (selectedRuntimeCommands?.loading && !selectedRuntimeCommands.ready)) ? (
        <div className="px-3 py-6 text-sm text-muted-foreground">
          {translate('auto.components.settings.QuickCommandsPane.601d6af51f', 'Loading commands…')}
        </div>
      ) : (
        <>
          {shouldShowQuickCommandsRefreshError(
            selectedRuntimeCommandsAreCurrent,
            selectedRuntimeCommands
          ) ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3">
              <span className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.QuickCommandsPane.923ba89646',
                  'Could not refresh commands from this host. Showing the last loaded commands.'
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() =>
                  selectedEnvironmentId &&
                  void loadRuntimeCommands(selectedEnvironmentId, { force: true })
                }
              >
                {translate('auto.components.settings.QuickCommandsPane.7ecfee5b8e', 'Retry')}
              </Button>
            </div>
          ) : null}
          <QuickCommandsList
            commands={commands}
            visibleCommands={visibleCommands}
            hasQuery={query.trim().length > 0}
            repoById={repoById}
            onEdit={(command) =>
              setEditor({
                mode: 'edit',
                command,
                connectionGeneration: selectedRuntimeConnectionGeneration,
                hostId: selectedHostId
              })
            }
            onRemove={(command) => void removeCommand(command)}
          />
        </>
      )}

      {editor !== null ? (
        <TerminalQuickCommandDialog
          open
          mode={editor.mode}
          command={editor.command}
          repos={hostRepos}
          defaultAdvancedOpen
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={saveCommand}
        />
      ) : null}
    </div>
  )
}
