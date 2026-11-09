import { toast } from 'sonner'
import { pluginCommandResultMessageSchema } from '../../../shared/plugins/contributions/plugin-workspace-command-args'

/** Shows a worker command's `{ message }` answer as a toast. */
export function showPluginCommandMessage(result: unknown): void {
  const reply = pluginCommandResultMessageSchema.safeParse(result)
  if (reply.success) {
    // Why untranslated: the plugin wrote it, like its manifest titles.
    toast(reply.data.message)
  }
}
