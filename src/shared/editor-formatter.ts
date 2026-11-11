import { z } from 'zod'
import { tokenizeCustomCommandTemplate } from './source-control/ai/generation/commit-message-prompt'

export const editorFormatterSchema = z.object({
  command: z.string().max(4096),
  include: z.array(z.string().min(1).max(512)).max(32)
})

export type EditorFormatter = z.infer<typeof editorFormatterSchema>

export type EditorFormatResult = { kind: 'skipped' } | { kind: 'formatted'; text: string }

export const DEFAULT_FORMATTER_INCLUDE = '**/*.{ts,tsx,js,jsx,json,css,scss,html,md,yaml,yml}'

export function editorFormatterArgv(
  command: string,
  filePath: string,
  relativePath: string,
  platform: NodeJS.Platform
): string[] {
  const parsed = tokenizeCustomCommandTemplate(command, platform === 'win32' ? 'literal' : 'escape')
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  if (!parsed.tokens[0]) {
    throw new Error('Configure a formatter command in project settings.')
  }
  if (parsed.tokens.some((token) => token === '--write' || token === '-w')) {
    throw new Error('Use a stdin/stdout formatter command, without --write or -w.')
  }
  // Substitute after tokenization: paths are arguments, never shell syntax or another template.
  return parsed.tokens.map((token) =>
    token.replace(/\$\{(file|relativeFile)\}/g, (_, name: string) =>
      name === 'file' ? filePath : relativePath
    )
  )
}
