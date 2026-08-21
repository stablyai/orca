import { useEffect, useRef, useState, type RefObject } from 'react'
import { Download, FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { CreateProjectParentBrowser } from '@/components/sidebar/CreateProjectLocationField'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RepoKind } from '../../../../shared/repo-types'
import { pickLocalProjectLocationFolder } from './pick-local-project-folder'
import { CloneForm, ExistingFolderForm, LocationActionButton } from './SetProjectLocationForms'

type DialogView = 'choose' | 'existing' | 'clone' | 'browse'
type BrowseField = 'existing' | 'clone'

type SetProjectLocationDialogProps = {
  option: NeedsSetupProjectHostOption | null
  projectName: string
  projectKind: RepoKind
  defaultCloneUrl: string
  onClose: () => void
  onReady: (setupId: string) => void
}

export function SetProjectLocationDialog({
  option,
  projectName,
  projectKind,
  defaultCloneUrl,
  onClose,
  onReady
}: SetProjectLocationDialogProps): React.JSX.Element {
  const open = option !== null
  // Why: keep the last option rendered through the close animation, so the body
  // doesn't blank out as the dialog slides away.
  const [renderOption, setRenderOption] = useState(option)
  if (option !== null && option !== renderOption) {
    setRenderOption(option)
  }
  const activeOption = option ?? renderOption
  // Why: Radix dismisses on Escape from a document-capture listener, so the host
  // browser can never intercept it itself. The body parks a back-out here so
  // Escape steps out of the browser instead of discarding the half-filled form.
  const exitHostBrowser = useRef<(() => boolean) | null>(null)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent
        data-testid="set-project-location-dialog"
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (exitHostBrowser.current?.()) {
            // Radix only skips onDismiss when the escape was defaultPrevented.
            event.preventDefault()
          }
        }}
      >
        {activeOption ? (
          <SetProjectLocationDialogBody
            key={activeOption.id}
            option={activeOption}
            projectName={projectName}
            projectKind={projectKind}
            defaultCloneUrl={defaultCloneUrl}
            exitHostBrowser={exitHostBrowser}
            onReady={onReady}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SetProjectLocationDialogBody({
  option,
  projectName,
  projectKind,
  defaultCloneUrl,
  exitHostBrowser,
  onReady
}: {
  option: NeedsSetupProjectHostOption
  projectName: string
  projectKind: RepoKind
  defaultCloneUrl: string
  exitHostBrowser: RefObject<(() => boolean) | null>
  onReady: (setupId: string) => void
}): React.JSX.Element {
  const setupProjectExistingFolder = useAppStore((state) => state.setupProjectExistingFolder)
  const setupProjectClone = useAppStore((state) => state.setupProjectClone)
  const [view, setView] = useState<DialogView>('choose')
  const [browseField, setBrowseField] = useState<BrowseField>('existing')
  const [setupPath, setSetupPath] = useState('')
  const [setupKind, setSetupKind] = useState<RepoKind>(projectKind)
  const [cloneUrl, setCloneUrl] = useState(defaultCloneUrl)
  const [cloneDestination, setCloneDestination] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Why: an SSH clone is unbounded and the dialog stays dismissable while it
  // runs. Without this, a clone the user backed out of minutes ago still fires
  // onReady, silently moving the run target (and resetting start-from) under a
  // form they have since pointed at another host.
  const abandoned = useRef(false)
  useEffect(() => {
    // Re-armed on mount: StrictMode runs mount/cleanup/mount, and latching this
    // on the first cleanup would disable the success path for the whole session.
    abandoned.current = false
    return () => {
      abandoned.current = true
    }
  }, [])
  const parsedHost = parseExecutionHostId(option.hostId)
  // Remote hosts browse in-dialog; the local host gets the native folder picker.
  const remoteHost =
    parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' ? parsedHost : null
  const canClone = projectKind === 'git'
  // Both views browse for a path; this is the field each one writes back to.
  const pathFields: Record<BrowseField, { value: string; set: (path: string) => void }> = {
    existing: { value: setupPath, set: setSetupPath },
    clone: { value: cloneDestination, set: setCloneDestination }
  }

  const browsing = view === 'browse' && remoteHost !== null
  useEffect(() => {
    exitHostBrowser.current = browsing
      ? () => {
          setView(browseField)
          return true
        }
      : null
    return () => {
      exitHostBrowser.current = null
    }
  }, [browseField, browsing, exitHostBrowser])

  const openHostBrowser = (field: BrowseField): void => {
    if (!remoteHost) {
      void pickLocalProjectLocationFolder(pathFields[field].set)
      return
    }
    setBrowseField(field)
    setView('browse')
  }

  const handleExistingSubmit = async (): Promise<void> => {
    if (!setupPath.trim()) {
      return
    }
    setIsSubmitting(true)
    try {
      const result = await setupProjectExistingFolder({
        projectId: option.projectId,
        hostId: option.hostId,
        path: setupPath.trim(),
        kind: setupKind,
        displayName: projectName
      })
      if (result && !abandoned.current) {
        onReady(result.setup.id)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCloneSubmit = async (): Promise<void> => {
    if (!cloneUrl.trim() || !cloneDestination.trim()) {
      return
    }
    setIsSubmitting(true)
    try {
      const result = await setupProjectClone({
        projectId: option.projectId,
        hostId: option.hostId,
        url: cloneUrl.trim(),
        destination: cloneDestination.trim(),
        displayName: projectName
      })
      if (result && !abandoned.current) {
        onReady(result.setup.id)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  if (browsing && remoteHost) {
    return (
      <CreateProjectParentBrowser
        sshTargetId={remoteHost.kind === 'ssh' ? remoteHost.targetId : null}
        runtimeEnvironmentId={remoteHost.kind === 'runtime' ? remoteHost.environmentId : null}
        createParent={pathFields[browseField].value}
        onParentChange={pathFields[browseField].set}
        onClose={() => setView(browseField)}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.new.workspace.SetProjectLocationDialog.title',
            'Set project location'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.new.workspace.SetProjectLocationDialog.description',
            'Choose where {{project}} lives on {{host}}.',
            { project: projectName, host: option.label }
          )}
        </DialogDescription>
      </DialogHeader>
      {view === 'choose' ? (
        <div className="space-y-2">
          <LocationActionButton
            icon={FolderOpen}
            title={translate(
              'auto.components.new.workspace.SetProjectLocationDialog.browseFolder',
              'Browse folder'
            )}
            description={translate(
              'auto.components.new.workspace.SetProjectLocationDialog.browseFolderHelp',
              'Use an existing checkout or folder on this host.'
            )}
            onClick={() => {
              setView('existing')
              // Local hosts get the native picker straight away — one click instead of two.
              if (!remoteHost && !setupPath) {
                void pickLocalProjectLocationFolder(setSetupPath)
              }
            }}
          />
          {canClone ? (
            <LocationActionButton
              icon={Download}
              title={translate(
                'auto.components.new.workspace.SetProjectLocationDialog.cloneFromUrl',
                'Clone from URL'
              )}
              description={translate(
                'auto.components.new.workspace.SetProjectLocationDialog.cloneFromUrlHelp',
                'Clone this repository onto {{host}}.',
                { host: option.label }
              )}
              onClick={() => setView('clone')}
            />
          ) : null}
        </div>
      ) : null}
      {view === 'existing' ? (
        <ExistingFolderForm
          setupPath={setupPath}
          setupKind={setupKind}
          isSubmitting={isSubmitting}
          onBack={() => setView('choose')}
          onPathChange={setSetupPath}
          onKindChange={setSetupKind}
          onBrowse={() => openHostBrowser('existing')}
          onSubmit={() => void handleExistingSubmit()}
        />
      ) : null}
      {view === 'clone' ? (
        <CloneForm
          cloneUrl={cloneUrl}
          cloneDestination={cloneDestination}
          isSubmitting={isSubmitting}
          onBack={() => setView('choose')}
          onCloneUrlChange={setCloneUrl}
          onCloneDestinationChange={setCloneDestination}
          onBrowse={() => openHostBrowser('clone')}
          onSubmit={() => void handleCloneSubmit()}
        />
      ) : null}
    </>
  )
}
