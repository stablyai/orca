import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { pluginFileExtensionSchema } from '../../../../../shared/plugins/contributions/plugin-file-match'

export type NewFileTypeOption = {
  extension: string
  label: string
}

export function getCommonNewFileTypes(t: Translate = translate): NewFileTypeOption[] {
  return [
    {
      extension: '.ts',
      label: t('components.editor.newFileExtensionPicker.types.ts', 'TypeScript')
    },
    {
      extension: '.tsx',
      label: t('components.editor.newFileExtensionPicker.types.tsx', 'TypeScript React')
    },
    {
      extension: '.js',
      label: t('components.editor.newFileExtensionPicker.types.js', 'JavaScript')
    },
    {
      extension: '.jsx',
      label: t('components.editor.newFileExtensionPicker.types.jsx', 'JavaScript React')
    },
    {
      extension: '.json',
      label: t('components.editor.newFileExtensionPicker.types.json', 'JSON')
    },
    {
      extension: '.py',
      label: t('components.editor.newFileExtensionPicker.types.py', 'Python')
    },
    {
      extension: '.txt',
      label: t('components.editor.newFileExtensionPicker.types.txt', 'Plain Text')
    },
    {
      extension: '.md',
      label: t('components.editor.newFileExtensionPicker.types.md', 'Markdown')
    },
    {
      extension: '.html',
      label: t('components.editor.newFileExtensionPicker.types.html', 'HTML')
    },
    {
      extension: '.css',
      label: t('components.editor.newFileExtensionPicker.types.css', 'CSS')
    },
    {
      extension: '.yaml',
      label: t('components.editor.newFileExtensionPicker.types.yaml', 'YAML')
    },
    {
      extension: '.toml',
      label: t('components.editor.newFileExtensionPicker.types.toml', 'TOML')
    },
    {
      extension: '.sh',
      label: t('components.editor.newFileExtensionPicker.types.sh', 'Shell Script')
    },
    {
      extension: '.sql',
      label: t('components.editor.newFileExtensionPicker.types.sql', 'SQL')
    },
    {
      extension: '.rs',
      label: t('components.editor.newFileExtensionPicker.types.rs', 'Rust')
    },
    {
      extension: '.go',
      label: t('components.editor.newFileExtensionPicker.types.go', 'Go')
    },
    {
      extension: '.xml',
      label: t('components.editor.newFileExtensionPicker.types.xml', 'XML')
    },
    {
      extension: '.csv',
      label: t('components.editor.newFileExtensionPicker.types.csv', 'CSV')
    }
  ]
}

/** Normalizes user input (`ts`, `.ts`, `d.ts`) into a portable dotted suffix, or null if invalid. */
export function normalizeNewFileExtension(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  const parsed = pluginFileExtensionSchema.safeParse(withDot)
  return parsed.success ? parsed.data : null
}

export type NewFileExtensionSelection =
  | { type: 'extension'; extension: string }
  | { type: 'cancel' }

export type NewFileExtensionPickerRequest = {
  id: string
  resolve: (selection: NewFileExtensionSelection) => void
}

type NewFileExtensionPickerListener = (request: NewFileExtensionPickerRequest) => void

let listener: NewFileExtensionPickerListener | null = null
let nextRequestId = 0

function once<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let called = false
  return (...args: T) => {
    if (called) {
      return
    }
    called = true
    fn(...args)
  }
}

export function subscribeNewFileExtensionPicker(
  nextListener: NewFileExtensionPickerListener
): () => void {
  listener = nextListener
  return () => {
    if (listener === nextListener) {
      listener = null
    }
  }
}

export function requestNewFileExtension(): Promise<NewFileExtensionSelection> {
  if (!listener) {
    return Promise.resolve({ type: 'cancel' })
  }

  return new Promise((resolve) => {
    listener?.({
      id: `new-file-extension-${nextRequestId}`,
      resolve: once(resolve)
    })
    nextRequestId += 1
  })
}
