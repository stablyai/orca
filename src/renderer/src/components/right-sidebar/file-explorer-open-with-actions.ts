import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  addOpenWithApplication,
  buildOpenWithCommand,
  getOpenWithFileTypeKey,
  resolveOpenWithDefaultApplication,
  setOpenWithDefault
} from '../../../../shared/open-with-applications'
import type { OpenInApplication, OpenWithApplication } from '../../../../shared/types'
import {
  isFileExplorerLocalOpenBlocked,
  openFileExplorerPathWithSystemDefault,
  resolveActiveWorkspaceConnectionId
} from './file-explorer-system-open'
import { showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'

export const NO_OPEN_WITH_APPLICATIONS: readonly OpenWithApplication[] = []

/**
 * Registered picks first, then the workspace "Open in" editors that aren't
 * already registered — a user who set up Cursor there shouldn't have to add it
 * a second time here.
 */
export function mergeOpenWithMenuEntries(
  openWithApplications: readonly OpenWithApplication[],
  openInApplications: readonly OpenInApplication[]
): OpenWithApplication[] {
  const registeredCommands = new Set(openWithApplications.map((entry) => entry.command))
  return [
    ...openWithApplications,
    ...openInApplications
      .filter((entry) => !registeredCommands.has(entry.command))
      .map((entry) => ({ ...entry, applicationPath: '' }))
  ]
}

function launchFailureMessage(label: string): string {
  return translate(
    'components.right.sidebar.fileExplorerOpenWith.launchFailed',
    "Couldn't open the file with {{app}}.",
    { app: label }
  )
}

/**
 * Runs a registered app against the path. Reuses the external-editor lane so
 * SSH workspaces keep their remote handling instead of launching a client-side
 * path that belongs to another machine.
 */
export async function openPathWithApplication(
  path: string,
  application: OpenWithApplication,
  connectionId: string | null
): Promise<void> {
  // Why: without an SSH connection to launch through, a remote-runtime path
  // belongs to another machine — say so here rather than letting the launcher
  // reject it and surface a generic failure.
  if (!connectionId && isFileExplorerLocalOpenBlocked(useAppStore.getState())) {
    showLocalPathOpenBlockedToast()
    return
  }
  const result = await window.api.shell.openInExternalEditor({
    path,
    command: application.command,
    connectionId
  })
  if (!result.ok) {
    toast.error(launchFailureMessage(application.label))
  }
}

/** ⌘O target: the per-type rule when one exists, otherwise the OS association. */
export async function openPathWithPreferredApplication(
  path: string,
  connectionId?: string | null
): Promise<void> {
  const state = useAppStore.getState()
  const application = resolveOpenWithDefaultApplication(
    path,
    state.settings?.openWithApplications ?? NO_OPEN_WITH_APPLICATIONS,
    state.settings?.openWithDefaults
  )
  if (!application) {
    await openFileExplorerPathWithSystemDefault(path)
    return
  }
  const resolvedConnectionId =
    connectionId === undefined ? resolveActiveWorkspaceConnectionId(state) : connectionId
  await openPathWithApplication(path, application, resolvedConnectionId)
}

/**
 * Opens the OS app picker and registers the choice. Returns the stored row so
 * callers can launch it immediately — picking an app the user then has to click
 * again would be a pointless second step.
 */
export async function pickAndRegisterOpenWithApplication(): Promise<OpenWithApplication | null> {
  const picked = await window.api.shell.pickApplication()
  if (!picked) {
    return null
  }
  const state = useAppStore.getState()
  const existing = (state.settings?.openWithApplications ?? NO_OPEN_WITH_APPLICATIONS).find(
    (application) => application.applicationPath === picked.applicationPath
  )
  const application: OpenWithApplication = {
    id: existing?.id ?? `open-with-${crypto.randomUUID()}`,
    label: picked.label,
    command: picked.command,
    applicationPath: picked.applicationPath
  }
  await state.updateSettings({
    openWithApplications: addOpenWithApplication(
      state.settings?.openWithApplications ?? NO_OPEN_WITH_APPLICATIONS,
      application
    )
  })
  return application
}

/** Pins the app as the handler for this entry's extension (toggles off when already set). */
export async function toggleOpenWithDefault(
  path: string,
  application: OpenWithApplication
): Promise<string | null> {
  const fileTypeKey = getOpenWithFileTypeKey(path)
  if (!fileTypeKey) {
    return null
  }
  const state = useAppStore.getState()
  const registered = state.settings?.openWithApplications ?? NO_OPEN_WITH_APPLICATIONS
  const defaults = state.settings?.openWithDefaults
  if (defaults?.[fileTypeKey] === application.id) {
    await state.updateSettings({
      openWithDefaults: setOpenWithDefault(defaults, fileTypeKey, null)
    })
    return null
  }
  // Why: the menu also offers workspace "Open in" editors, which live in a
  // different setting. Adopt the pick so the rule resolves and survives
  // normalization instead of silently falling back to the OS default.
  await state.updateSettings({
    openWithApplications: registered.some((entry) => entry.id === application.id)
      ? [...registered]
      : addOpenWithApplication(registered, application),
    openWithDefaults: setOpenWithDefault(defaults, fileTypeKey, application.id)
  })
  return application.id
}

export { buildOpenWithCommand, getOpenWithFileTypeKey, resolveOpenWithDefaultApplication }
