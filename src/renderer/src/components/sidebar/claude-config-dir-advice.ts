import { parseClaudeConfigDirBinding } from '../../../../shared/claude-home-binding'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { translate } from '@/i18n/i18n'

/** What the filesystem said about a draft directory, or null while the probe is in flight. */
export type ClaudeConfigDirProbe = {
  directoryExists: boolean
  signedIn: boolean
}

export type ClaudeConfigDirAdviceCode = 'not-absolute' | 'missing-directory' | 'signed-out'

export type ClaudeConfigDirAdvice = {
  code: ClaudeConfigDirAdviceCode
  message: string
}

/** The file whose presence is the cheapest "this home has been signed in" signal. */
export function getClaudeConfigDirCredentialsPath(configDir: string): string {
  return resolveRuntimePath(configDir, '.credentials.json')
}

/**
 * Advisory only. The authoritative refusal happens at launch, because the directory can be
 * deleted or signed out between editing and launching — so this never blocks a save.
 */
export function evaluateClaudeConfigDirAdvice(args: {
  draft: string
  probe: ClaudeConfigDirProbe | null
}): ClaudeConfigDirAdvice | null {
  if (!args.draft.trim()) {
    return null
  }
  if (!parseClaudeConfigDirBinding(args.draft)) {
    return {
      code: 'not-absolute',
      message: translate(
        'auto.components.sidebar.ProjectGroupSettingsDialog.adviceNotAbsolute',
        'This is not an absolute path. Claude sessions in this group would resolve it differently each run.'
      )
    }
  }
  if (!args.probe) {
    return null
  }
  if (!args.probe.directoryExists) {
    return {
      code: 'missing-directory',
      message: translate(
        'auto.components.sidebar.ProjectGroupSettingsDialog.adviceMissingDirectory',
        'That directory does not exist yet on this group’s host.'
      )
    }
  }
  if (!args.probe.signedIn) {
    return {
      code: 'signed-out',
      message: translate(
        'auto.components.sidebar.ProjectGroupSettingsDialog.adviceSignedOut',
        'That directory has no Claude credentials yet, so sessions will start signed out.'
      )
    }
  }
  return null
}
