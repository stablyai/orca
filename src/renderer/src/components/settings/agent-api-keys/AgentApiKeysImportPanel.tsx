import { useState } from 'react'
import { KeyRound, Loader2, LogIn } from 'lucide-react'
import type { AgentApiKeysImportResult } from '../../../../../shared/agent-api-keys/agent-api-key-cloud'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { InlineError } from '../../ui/inline-error'
import { Skeleton } from '../../ui/skeleton'
import type { AgentApiKeysModel } from './use-agent-api-keys'
import {
  defaultImportSelection,
  importOutcome,
  importSourceLabel,
  isMacPlatform,
  signInProviderLabel,
  type ImportScanState
} from './agent-api-keys-import'

/**
 * Keys this computer already uses, by name only: main holds the values and re-reads them on import.
 * Sign-ins are listed so the user knows they weren't copied.
 */
/** The import panel's state: closed (null), scanning, failed or ready, and the import itself. */
export function useAgentApiKeysImport(
  model: Pick<AgentApiKeysModel, 'scanThisComputer' | 'importFromThisComputer'>,
  initial: ImportScanState | null,
  onDone: (outcome: ReturnType<typeof importOutcome>) => void
): {
  scan: ImportScanState | null
  start: () => void
  close: () => void
  run: (names: string[]) => Promise<AgentApiKeysImportResult | null>
} {
  const t = useTranslate()
  const [scan, setScan] = useState<ImportScanState | null>(initial)
  const start = (): void => {
    const scanThisComputer = model.scanThisComputer
    if (!scanThisComputer) {
      return
    }
    setScan({ kind: 'scanning' })
    scanThisComputer().then(
      (found) => setScan((current) => (current ? { kind: 'ready', scan: found } : current)),
      () => setScan((current) => (current ? { kind: 'failed' } : current))
    )
  }
  const run = async (names: string[]): Promise<AgentApiKeysImportResult | null> => {
    const result = (await model.importFromThisComputer?.(names)) ?? null
    if (result) {
      onDone(importOutcome(result, t))
      setScan(null)
    }
    return result
  }
  return { scan, start, close: () => setScan(null), run }
}

export function AgentApiKeysImportPanel({
  scan,
  signedIn,
  onRetry,
  onImport,
  onClose
}: {
  scan: ImportScanState
  signedIn: boolean
  onRetry: () => void
  onImport: (names: string[]) => Promise<AgentApiKeysImportResult | null>
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const place = isMacPlatform()
    ? t('agentApiKeys.import.thisMac', 'this Mac')
    : t('agentApiKeys.import.thisComputer', 'this computer')
  const [selected, setSelected] = useState<string[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [failed, setFailed] = useState(false)
  const chosen = selected ?? (scan.kind === 'ready' ? defaultImportSelection(scan.scan) : [])

  const run = async (): Promise<void> => {
    if (importing || chosen.length === 0) {
      return
    }
    setImporting(true)
    setFailed(false)
    const result = await onImport(chosen)
    setImporting(false)
    if (!result) {
      setFailed(true)
    }
  }

  return (
    <section
      aria-labelledby="agent-api-keys-import-title"
      className="space-y-3 rounded-xl border border-border bg-card/50 px-5 py-4 shadow-xs"
    >
      <div className="space-y-1">
        <h4 id="agent-api-keys-import-title" className="text-sm font-medium">
          {t('agentApiKeys.import.title', 'Keys found on {{place}}', { place })}
        </h4>
        <p className="text-xs text-muted-foreground">
          {signedIn
            ? t(
                'agentApiKeys.import.detailSignedIn',
                'Orca shows names only. Imported keys are sealed on this computer, used on every host, and saved in your Orca account.'
              )
            : t(
                'agentApiKeys.import.detailSignedOut',
                'Orca shows names only. Imported keys are sealed on this computer and used on every host.'
              )}
        </p>
      </div>

      {scan.kind === 'scanning' ? (
        <div aria-busy="true" className="space-y-2">
          <span className="sr-only">{t('agentApiKeys.import.scanning', 'Looking for keys…')}</span>
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-4/5" />
        </div>
      ) : scan.kind === 'failed' ? (
        <InlineError
          density="compact"
          title={t('agentApiKeys.import.scanFailed', 'Couldn’t look for keys on {{place}}.', {
            place
          })}
          retryLabel={t('agentApiKeys.import.retry', 'Try again')}
          onRetry={onRetry}
        />
      ) : (
        <>
          {scan.scan.keys.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'agentApiKeys.import.empty',
                'No agent API keys found in your shell environment, OpenCode or ~/.gemini/.env.'
              )}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {scan.scan.keys.map((key) => {
                const id = `agent-api-key-import-${key.name}`
                const checked = chosen.includes(key.name)
                return (
                  <li
                    key={key.name}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40"
                  >
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={key.alreadySaved || importing}
                      onCheckedChange={(next) =>
                        setSelected(
                          next === true
                            ? [...chosen, key.name]
                            : chosen.filter((name) => name !== key.name)
                        )
                      }
                    />
                    <AgentIcon agent={key.agent} size={14} />
                    <label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-3">
                      <code className="w-52 shrink-0 truncate font-mono text-xs">{key.name}</code>
                      <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                        ••••{key.hint}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {key.alreadySaved
                          ? t('agentApiKeys.import.alreadySaved', 'Already saved for {{agent}}', {
                              agent: getAgentLabel(key.agent)
                            })
                          : `${getAgentLabel(key.agent)} · ${importSourceLabel(key.source, t)}`}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {scan.scan.signIns.length > 0 ? (
            <ul className="space-y-1 border-t border-border pt-3">
              {scan.scan.signIns.map((signIn) => (
                <li
                  key={`${signIn.agent}:${signIn.provider}`}
                  className="flex items-center gap-3 px-2 text-xs text-muted-foreground"
                >
                  <LogIn aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {t(
                      'agentApiKeys.import.signIn',
                      '{{agent}} is signed in with {{provider}}. Sign in once in Settings › Agent accounts.',
                      {
                        agent: getAgentLabel(signIn.agent),
                        provider: signInProviderLabel(signIn)
                      }
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {failed ? (
        <InlineError
          density="compact"
          title={t('agentApiKeys.import.failed', 'Couldn’t import. Nothing was changed.')}
        />
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('agentApiKeys.import.cancel', 'Cancel')}
        </Button>
        {scan.kind === 'ready' && scan.scan.keys.length > 0 ? (
          <Button
            size="sm"
            disabled={chosen.length === 0}
            aria-disabled={importing || undefined}
            aria-busy={importing || undefined}
            onClick={() => void run()}
          >
            {importing ? <Loader2 className="motion-safe:animate-spin" /> : <KeyRound />}
            {chosen.length === 1
              ? t('agentApiKeys.import.submitOne', 'Import 1 key')
              : t('agentApiKeys.import.submit', 'Import {{count}} keys', {
                  count: chosen.length
                })}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
