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
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption
} from '@/lib/project-host-setup-options'
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
  // Keep the last body through the close animation to avoid blanking it mid-exit.
  const [renderOption, setRenderOption] = useState(option)
  if (option !== null && option !== renderOption) {
    setRenderOption(option)
  }
  const activeOption = option ?? renderOption
  // Radix captures document Escape first; delegate browser back-out here so the form survives leaving the browser.
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
  // Clones may finish long after dismissal; do not retarget a composer the user has since moved to another host.
  const abandoned = useRef(false)
  useEffect(() => {
    // Reset on mount because StrictMode’s setup/cleanup/setup would otherwise permanently abandon this dialog.
    abandoned.current = false
    return () => {
      abandoned.current = true
    }
  }, [])
  const parsedHost = parseExecutionHostId(option.hostId)
  const remoteHost =
    parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' ? parsedHost : null
  const canClone = projectKind === 'git'
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
        onReady(getProjectHostSetupSelectionKey({ id: result.setup.id, hostId: option.hostId }))
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
        onReady(getProjectHostSetupSelectionKey({ id: result.setup.id, hostId: option.hostId }))
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
