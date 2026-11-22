import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import {
  botToolInputError,
  type BotToolInput,
  type BotToolDetails,
  type BotToolServer
} from '../../../../shared/bot-tools'

export type SecretDraft = { id: string; key: string; value: string; configured: boolean }
export type BotToolDraft = {
  name: string
  mode: 'url' | 'command'
  url: string
  command: string
  args: { id: string; value: string }[]
  headers: SecretDraft[]
  env: SecretDraft[]
}
export const emptyBotToolDraft = (): BotToolDraft => ({
  name: '',
  mode: 'url',
  url: '',
  command: '',
  args: [],
  headers: [],
  env: []
})
export function draftFromServer(server: BotToolServer | BotToolDetails['server']): BotToolDraft {
  const draft = { ...emptyBotToolDraft(), name: server.name }
  const rows = (
    values: Record<string, string> | { key: string; configured: boolean }[] | undefined
  ): SecretDraft[] =>
    Array.isArray(values)
      ? values.map((row) => ({ ...row, id: createBrowserUuid(), value: '' }))
      : Object.entries(values ?? {}).map(([key, value]) => ({
          id: createBrowserUuid(),
          key,
          value,
          configured: false
        }))
  return 'url' in server
    ? { ...draft, url: server.url, headers: rows(server.headers) }
    : {
        ...draft,
        mode: 'command',
        command: server.command,
        args: server.args.map((value) => ({ id: createBrowserUuid(), value })),
        env: rows(server.env)
      }
}
export function botToolDraftInput(draft: BotToolDraft): BotToolInput {
  const rows = (values: SecretDraft[]) =>
    values.map(({ key, value, configured }) =>
      configured && value === '' ? { key, keep: true as const } : { key, value }
    )
  return draft.mode === 'url'
    ? { name: draft.name, url: draft.url, transport: 'http', headers: rows(draft.headers) }
    : {
        name: draft.name,
        command: draft.command,
        args: draft.args.map((arg) => arg.value),
        env: rows(draft.env)
      }
}
export function botToolDraftError(
  draft: BotToolDraft,
  platform: NodeJS.Platform,
  saved?: BotToolDetails
): string | null {
  const validationError = botToolInputError(botToolDraftInput(draft), platform)
  if (validationError) {
    return validationError
  }
  const remote = draft.mode === 'url'
  const rows = remote ? draft.headers : draft.env
  if (saved && rows.some((row) => row.configured && !row.value)) {
    const previous = saved.server
    const unchanged = remote
      ? 'url' in previous && new URL(previous.url).origin === new URL(draft.url).origin
      : 'command' in previous && previous.command === draft.command
    if (!unchanged) {
      return 'The credential destination changed. Re-enter saved values or remove their rows.'
    }
  }
  return null
}
