import { AccountHomeImport, AccountHomeImportForm } from '../AccountHomeImport'
import type { CodexAccountActionRunner } from '../accounts-pane-types'
import type { LocalAccountRuntime } from '@/lib/provider-accounts/account-runtime-label'

type Props = {
  runtime: LocalAccountRuntime
  disabled: boolean
  runAction: CodexAccountActionRunner
}

function importAccount(runtime: LocalAccountRuntime, sourceHome: string) {
  return window.api.codexAccounts.importHome({
    sourceHome,
    runtime: runtime.runtime,
    wslDistro: runtime.wslDistro
  })
}

export function CodexHomeImportForm(props: Props & { onImported: () => void }) {
  return (
    <AccountHomeImportForm
      {...props}
      disabled={props.disabled || props.runtime.runtime === 'wsl'}
      provider="Codex"
      importAccount={(path) => importAccount(props.runtime, path)}
    />
  )
}

export function CodexHomeImport(props: Props) {
  return (
    <AccountHomeImport
      {...props}
      disabled={props.disabled || props.runtime.runtime === 'wsl'}
      provider="Codex"
      importAccount={(path) => importAccount(props.runtime, path)}
    />
  )
}
