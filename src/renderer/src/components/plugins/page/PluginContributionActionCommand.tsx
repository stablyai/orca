import { useState } from 'react'
import { flushSync } from 'react-dom'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { useAppStore } from '@/store'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { Button } from '../../ui/button'

const RESULT_PREVIEW_LIMIT = 200

/** Worker results cross IPC as plain data, so JSON is a faithful preview; anything else is in Logs. */
function serializeResult(result: unknown): string | undefined {
  if (typeof result === 'string') {
    return result.trim()
  }
  try {
    return JSON.stringify(result)
  } catch {
    return undefined
  }
}

function resultPreview(result: unknown): string | null {
  const text = result === null || result === undefined ? '' : (serializeResult(result) ?? '')
  if (text === '') {
    return null
  }
  return text.length > RESULT_PREVIEW_LIMIT ? `${text.slice(0, RESULT_PREVIEW_LIMIT)}…` : text
}

/** Runs one plugin command the same way the palette does, and says what happened. Built-in
 *  actions leave Settings first, since they act on the app behind it. */
export function PluginContributionActionCommand({
  command,
  unavailableReason
}: {
  command: ActivePluginCommand
  /** Set when the command can't run right now; the button stays visible but off. */
  unavailableReason: string | null
}): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const run = async (): Promise<void> => {
    setRunning(true)
    if (command.handler.type === 'built-in') {
      // Why sync: built-in actions act on the app view, and their dispatcher reads it only after
      // the closed Settings page commits.
      flushSync(() => useAppStore.getState().closeSettingsPage())
    }
    try {
      const result = await executePluginCommand(command, 'plugin-palette')
      const preview = resultPreview(result)
      toast.success(
        translate(
          'auto.components.settings.PluginContributionActionCommand.ran',
          'Ran {{value0}}',
          {
            value0: command.title
          }
        ),
        {
          description:
            preview ??
            (command.handler.type === 'worker'
              ? translate(
                  'auto.components.settings.PluginContributionActionCommand.seeLogs',
                  'See Logs below'
                )
              : undefined)
        }
      )
    } catch (cause: unknown) {
      toast.error(
        translate(
          'auto.components.settings.PluginContributionActionCommand.failed',
          '{{value0}} failed',
          { value0: command.title }
        ),
        { description: cause instanceof Error ? cause.message : String(cause) }
      )
    } finally {
      setRunning(false)
    }
  }
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={running || unavailableReason !== null}
      title={unavailableReason ?? undefined}
      aria-label={translate(
        'auto.components.settings.PluginContributionActionCommand.runName',
        'Run {{value0}}',
        { value0: command.title }
      )}
      onClick={() => void run()}
    >
      {translate('auto.components.settings.PluginContributionActionCommand.run', 'Run')}
    </Button>
  )
}
