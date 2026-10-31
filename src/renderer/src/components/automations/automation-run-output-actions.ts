import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { AutomationRunOutput } from '../../../../shared/automation-run-result-types'
import {
  readAutomationRunOutputForTarget,
  type AutomationHostTarget
} from './automation-host-client'
import type { AutomationRunOutputActions } from './AutomationRunResults'

function suggestedName(output: AutomationRunOutput): string {
  // Keep Windows-forbidden characters out of the save dialog's default name.
  const base = output.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100) || 'report'
  return `${base}.${output.format === 'html' ? 'html' : 'md'}`
}

/** Open and Download save a local copy first, like opening any remote file. */
export function createAutomationRunOutputActions(
  target: AutomationHostTarget,
  runId: string
): AutomationRunOutputActions {
  const load = (outputId: string): Promise<string> =>
    readAutomationRunOutputForTarget(target, runId, outputId)
  const save = async (output: AutomationRunOutput): Promise<string | null> => {
    const saved = await window.api.fs.saveDownloadedFile({
      suggestedName: suggestedName(output),
      content: await load(output.id),
      encoding: 'utf8'
    })
    return saved.canceled ? null : saved.destinationPath
  }
  const failed = (output: AutomationRunOutput, error: unknown): void => {
    toast.error(
      extractIpcErrorMessage(
        error,
        translate(
          'auto.components.automations.automationRunOutputActions.saveFailed',
          "Couldn't save '{{title}}'.",
          { title: output.title }
        )
      )
    )
  }
  return {
    load,
    open: (output) => {
      return save(output)
        .then(async (path) => {
          if (path && !(await window.api.shell.openFilePath(path, LOCAL_EXECUTION_HOST_ID))) {
            toast.error(
              translate(
                'auto.components.automations.automationRunOutputActions.openFailed',
                "Couldn't open the saved file at '{{path}}'.",
                { path }
              )
            )
          }
        })
        .catch((error: unknown) => failed(output, error))
    },
    download: async (output) => {
      await save(output).catch((error: unknown) => failed(output, error))
    }
  }
}
