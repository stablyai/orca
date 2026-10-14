import { z } from 'zod'
import { quotePosixShell } from '../../../src/shared/wsl-login-shell-command'
import { MAIL_PANE_AGENT_SOURCE } from './orchestration-mail-pane-agent'

const LedgerEntry = z.object({
  event: z.string(),
  data: z.string().optional(),
  requestId: z.string().optional(),
  status: z.number().nullable().optional(),
  stdout: z.string().optional(),
  terminalHandle: z.string().optional(),
  hasLaunchToken: z.boolean().optional()
})

/** Fixture files live only in the disposable Docker host, not in a user's SSH account. */
export function createManagedMailboxAgent(execute: (command: string) => string) {
  const root = '/tmp/orca-subscription-agent'
  const script = `${root}/agent.cjs`
  const ledger = `${root}/ledger.jsonl`
  const title = `${root}/title`
  const control = `${root}/control.json`
  const write = (file: string, contents: string): void => {
    execute(
      `printf %s ${quotePosixShell(Buffer.from(contents).toString('base64'))} | base64 -d > ${quotePosixShell(file)}`
    )
  }
  execute(`mkdir -p ${quotePosixShell(root)}`)
  write(script, MAIL_PANE_AGENT_SOURCE)
  write(ledger, '')
  const readLedger = (): z.infer<typeof LedgerEntry>[] =>
    execute(`cat ${quotePosixShell(ledger)}`)
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = LedgerEntry.safeParse(JSON.parse(line))
          return parsed.success ? [parsed.data] : []
        } catch {
          // The process may still be appending the last line.
          return []
        }
      })
  return {
    launchCommand: `node ${[script, ledger, title, '', control, '', 'orca'].map(quotePosixShell).join(' ')}`,
    readLedger,
    readStdin: () =>
      readLedger()
        .filter((entry) => entry.event === 'stdin')
        .map((entry) => entry.data ?? '')
        .join(''),
    setTitle: (value: string) => write(title, value),
    runCli: (requestId: string, args: string[]) =>
      write(control, JSON.stringify({ requestId, args })),
    readCliResult: (requestId: string) =>
      readLedger().find((entry) => entry.event === 'cli' && entry.requestId === requestId)
  }
}
