import { useCallback, useContext } from 'react'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import {
  fillTerminalQuickCommandArguments,
  getTerminalQuickCommandArguments
} from '../../../../shared/terminal-quick-command-arguments'

export type ResolveQuickCommandArguments = (
  command: TerminalQuickCommand
) => Promise<TerminalQuickCommand | null>

/** Asks for `{{name}}` argument values before a run; resolves null when the user cancels. */
export function useQuickCommandArgumentPrompt(): ResolveQuickCommandArguments {
  const confirm = useContext(ConfirmationDialogContext)
  return useCallback(
    async (command) => {
      const args = getTerminalQuickCommandArguments(command)
      if (args.length === 0) {
        return command
      }
      // Why: running unfilled `{{name}}` tokens would send literal braces to the shell or agent.
      if (!confirm) {
        return null
      }
      const filled: { values: Record<string, string> | null } = { values: null }
      const confirmed = await confirm({
        title: command.label,
        description: translate(
          'auto.components.terminal.quick.commands.QuickCommandArguments.description',
          'Fill in the arguments for this quick command.'
        ),
        confirmLabel: translate(
          'auto.components.terminal.quick.commands.QuickCommandArguments.run',
          'Run'
        ),
        fields: {
          inputs: args.map((arg) => ({
            id: arg.name,
            label: arg.required
              ? arg.name
              : translate(
                  'auto.components.terminal.quick.commands.QuickCommandArguments.optional_label',
                  '{{value0}} (optional)',
                  { value0: arg.name }
                ),
            type: arg.options ? 'select' : 'text',
            options: arg.options,
            defaultValue: arg.defaultValue,
            required: arg.required,
            autoComplete: 'off'
          })),
          onConfirmed: (next) => {
            filled.values = next
          }
        }
      })
      return confirmed && filled.values
        ? fillTerminalQuickCommandArguments(command, filled.values)
        : null
    },
    [confirm]
  )
}
