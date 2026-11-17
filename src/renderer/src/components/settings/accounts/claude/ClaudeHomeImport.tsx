import { AccountHomeImport } from '../AccountHomeImport'
import type { ClaudeAccountActionRunner } from '../accounts-pane-types'
import type { LocalAccountRuntime } from '@/lib/provider-accounts/account-runtime-label'

export function ClaudeHomeImport(props: {
  runtime: LocalAccountRuntime
  disabled: boolean
  runAction: ClaudeAccountActionRunner
}) {
  return (
    <AccountHomeImport
      {...props}
      provider="Claude"
      importAccount={(sourceHome, importHistory) =>
        window.api.claudeAccounts.importHome({ sourceHome, importHistory })
      }
    />
  )
}
