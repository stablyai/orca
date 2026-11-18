import { AccountHomeImport, AccountHomeImportForm } from '../AccountHomeImport'
import type { CodexAccountActionRunner } from '../accounts-pane-types'
import type { LocalAccountRuntime } from '@/lib/provider-accounts/account-runtime-label'

type Props = {
  runtime: LocalAccountRuntime
  disabled: boolean
  runAction: CodexAccountActionRunner
}

function importAccount(runtime: LocalAccountRuntime, sourceHome: string, importHistory: boolean) {
  return window.api.codexAccounts.importHome({
    sourceHome,
    importHistory,
    runtime: runtime.runtime,
    wslDistro: runtime.wslDistro
  })
}

export function CodexHomeImportForm(props: Props & { onImported: () => void }) {
  return (
    <AccountHomeImportForm
      {...props}
      provider="Codex"
      importAccount={(path, history) => importAccount(props.runtime, path, history)}
    />
  )
}

export function CodexHomeImport(props: Props) {
  return (
    <AccountHomeImport
      {...props}
      provider="Codex"
      importAccount={(path, history) => importAccount(props.runtime, path, history)}
    />
  )
}
