import { useMemo } from 'react'
import type { EditorOptions } from '@pierre/diffs/edit'
import PluginGrammarWorker from '@/lib/monaco-languages/plugin-grammar.worker?worker'
import {
  resolvePluginSyntaxForFile,
  usePluginSyntaxes
} from '@/store/plugins/syntax/plugin-syntax-packs'
import {
  pluginSyntaxRevisionKey,
  usePluginSyntaxFailureStore,
  recordPluginSyntaxFailure
} from '@/store/plugins/syntax/plugin-syntax-failures'
import { parsePluginSyntaxPayload } from '../../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { PierrePluginTokenizer } from './pierre-plugin-tokenizer'

type TokenizerFactory = EditorOptions<'file-diff', unknown, unknown>['createTokenizer']

export function usePierrePluginTokenizer(filePath: string, language: string): TokenizerFactory {
  const syntaxes = usePluginSyntaxes()
  const syntax = resolvePluginSyntaxForFile(syntaxes, filePath, language)
  const failed = usePluginSyntaxFailureStore((state) =>
    syntax ? state.failures[pluginSyntaxRevisionKey(syntax)] : undefined
  )
  return useMemo(
    () =>
      syntax && !failed
        ? (options, highlighter) =>
            new PierrePluginTokenizer(
              options,
              highlighter,
              async () => parsePluginSyntaxPayload(await window.api.plugins.loadSyntax(syntax.id)),
              () => new PluginGrammarWorker(),
              (reason) => recordPluginSyntaxFailure(pluginSyntaxRevisionKey(syntax), reason)
            )
        : undefined,
    [syntax, failed]
  )
}
