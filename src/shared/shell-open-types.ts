export type ShellOpenExternalEditorRequest = {
  path: string
  command?: string
  connectionId?: string | null
}

export type ShellOpenPathFailureReason =
  | 'not-absolute'
  | 'not-found'
  | 'launch-failed'
  | 'remote-runtime-unsupported'
  | 'ssh-target-not-found'
  | 'ssh-target-invalid'
  | 'ssh-alias-required'
  | 'remote-editor-unsupported'

export type ShellOpenLocalPathFailureReason = Extract<
  ShellOpenPathFailureReason,
  'not-absolute' | 'not-found' | 'launch-failed' | 'remote-runtime-unsupported'
>

export type ShellOpenLocalPathResult =
  | { ok: true }
  | { ok: false; reason: ShellOpenLocalPathFailureReason }

export type ShellOpenExternalEditorResult =
  | { ok: true }
  | { ok: false; reason: Exclude<ShellOpenPathFailureReason, 'ssh-alias-required'> }
  | { ok: false; reason: 'ssh-alias-required'; host: string; port: number }

export type ShellOpenWithApplication = {
  id: string
  name: string
  isDefault?: boolean
}

export type ShellListOpenWithApplicationsResult =
  | {
      ok: true
      applications: ShellOpenWithApplication[]
      supportsChooserDialog: boolean
    }
  | { ok: false; reason: ShellOpenLocalPathFailureReason }

export type ShellOpenPathWithApplicationRequest = {
  path: string
  applicationId: string
}

// Why: the Windows "How do you want to open this file?" dialog is offered as a
// synthetic entry so the renderer needs a stable id that can never collide
// with a discovered application id (those are prefixed by platform).
export const OPEN_WITH_CHOOSER_APPLICATION_ID = 'system:open-with-chooser'
