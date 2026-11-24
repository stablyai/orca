import type { Extension } from '@codemirror/state'
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import {
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { createCodeLspSyncExtension } from './code-lsp-sync'
import { createCodeNavigationExtension } from './code-navigation-extension'
import {
  createCodeCompletionSource,
  createCodeIntelligenceExtension
} from './code-intelligence-extension'
import { createCodeSignatureHelpExtension } from './code-signature-extension'

export type CodeIntelBundleContext = {
  filePath: string
  fileKey: string
  workspaceRoot: string | null
  language: string
  readOnly: boolean
}

export function createCodeIntelExtensionBundle(
  interactive: boolean,
  getContext: () => CodeIntelBundleContext
): Extension[] {
  const baseExtensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    foldGutter(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    search({ top: true }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...closeBracketsKeymap,
      indentWithTab
    ])
  ]
  if (!interactive) {
    return [autocompletion(), ...baseExtensions]
  }
  return [
    createCodeLspSyncExtension(getContext()),
    createCodeNavigationExtension(getContext),
    createCodeIntelligenceExtension(getContext),
    createCodeSignatureHelpExtension(getContext),
    autocompletion({ override: [createCodeCompletionSource(getContext)] }),
    ...baseExtensions
  ]
}
