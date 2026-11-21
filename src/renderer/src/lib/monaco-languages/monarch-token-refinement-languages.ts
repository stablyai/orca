import type * as Monaco from 'monaco-editor'
import {
  REFINED_TOKEN_STOCK_RULES,
  withTokenRefinements,
  type TokenRefinementSpec
} from './monarch-token-refinements'

type TokenRefinementLanguage = TokenRefinementSpec & {
  load: () => Promise<{ language: Monaco.languages.IMonarchLanguage }>
}

// Rules whose regex starts a C preprocessor directive (`#include`, `#define`).
const DIRECTIVE_RULES = /^\^\\s\*#/
// Rules whose regex starts a CSS at-rule (`@import`, `@media`).
const AT_RULES = /^\[@\]/

/** Monaco's languages with what TextMate themes color apart that Monaco's grammars don't: the words
 *  each language's TextMate grammar scopes `keyword.control`, and whether it scopes calls as functions. */
export const TOKEN_REFINEMENT_LANGUAGES: Record<string, TokenRefinementLanguage> = {
  apex: {
    controlWords: 'break catch continue do else finally for goto if return throw try when while',
    load: () => import('monaco-editor/esm/vs/basic-languages/apex/apex.js')
  },
  bicep: {
    controlWords: 'existing for if in module output param resource targetScope var',
    load: () => import('monaco-editor/esm/vs/basic-languages/bicep/bicep.js')
  },
  c: {
    controlWords:
      'break case catch continue default delete do else for goto if new operator return switch throw try using while',
    controlRules: DIRECTIVE_RULES,
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.js')
  },
  clojure: {
    controlWords:
      'declare def definline definterface defmacro defmethod defmulti defn defn- defonce defprotocol defrecord defstruct deftype import in-ns ns require use',
    load: () => import('monaco-editor/esm/vs/basic-languages/clojure/clojure.js')
  },
  coffeescript: {
    controlWords:
      'break by catch continue delete do else extends finally for if in loop of return switch then throw try unless until when while',
    memberAfterDot: 'delimiter',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/coffee/coffee.js')
  },
  cpp: {
    controlWords:
      'break case catch continue default delete do else for goto if new operator return switch throw try using while',
    controlRules: DIRECTIVE_RULES,
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.js')
  },
  csharp: {
    controlWords:
      'break catch checked continue do else finally fixed for foreach goto if in lock return switch throw try unchecked using while',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/csharp/csharp.js')
  },
  css: {
    controlRules: AT_RULES,
    load: () => import('monaco-editor/esm/vs/basic-languages/css/css.js')
  },
  cypher: {
    controlWords:
      'AS CALL CASE DISTINCT ELSE END LIMIT MATCH RETURN SKIP THEN UNION UNWIND WHEN WHERE WITH YIELD',
    load: () => import('monaco-editor/esm/vs/basic-languages/cypher/cypher.js')
  },
  dart: {
    controlWords:
      'assert async await break case catch continue default do else finally for if in on rethrow return switch sync throw try while yield',

    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/dart/dart.js')
  },
  elixir: {
    controlWords:
      'after alias case catch cond defexception defimpl defmodule defprotocol defstruct do else end fn for if import quote raise receive require rescue super throw try unless unquote use with',
    load: () => import('monaco-editor/esm/vs/basic-languages/elixir/elixir.js')
  },
  fsharp: {
    controlWords: 'do elif else finally for if in match return then try while with yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/fsharp/fsharp.js')
  },
  go: {
    controlWords:
      'break case continue default defer else fallthrough for go goto if import range return select switch',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/go/go.js')
  },
  java: {
    controlWords:
      'assert break case catch continue default do else finally for if new return switch throw try while yield',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/java/java.js')
  },
  javascript: {
    controlWords:
      'await break case catch continue default do else export finally for from if import return switch throw try while with yield',
    memberAfterDot: 'delimiter',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js')
  },
  julia: {
    controlWords:
      'begin break catch continue do else elseif end export finally for if import let return try using while',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/julia/julia.js')
  },
  kotlin: {
    controlWords: 'break continue do else for if return throw try when while',
    load: () => import('monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js')
  },
  lua: {
    controlWords: 'break do else elseif end for function goto if in repeat return then until while',
    load: () => import('monaco-editor/esm/vs/basic-languages/lua/lua.js')
  },
  'objective-c': {
    controlWords:
      '#define #if #ifdef #ifndef #import #include #undef break continue do else for goto if return switch while',
    load: () => import('monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js')
  },
  pascal: {
    controlWords: 'abort break continue do exit for raise repeat until while',
    load: () => import('monaco-editor/esm/vs/basic-languages/pascal/pascal.js')
  },
  perl: {
    controlWords:
      'continue die do else elsif eval exit for foreach goto if last next redo require return select unless until use wait while',
    load: () => import('monaco-editor/esm/vs/basic-languages/perl/perl.js')
  },
  php: {
    controlWords:
      'break case catch continue declare default die do else elseif enddeclare endfor endforeach endif endswitch endwhile exit for foreach if include include_once require require_once return switch throw try while yield',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/php/php.js')
  },
  powerquery: {
    controlWords: 'else if otherwise then try',
    load: () => import('monaco-editor/esm/vs/basic-languages/powerquery/powerquery.js')
  },
  powershell: {
    controlWords:
      'begin break catch continue data define do dynamicparam else elseif end exit finally for foreach from if in inlinescript parallel param process return sequence switch throw trap try until var while',
    memberAfterDot: 'delimiter',
    load: () => import('monaco-editor/esm/vs/basic-languages/powershell/powershell.js')
  },
  python: {
    controlWords:
      'as assert async await break case continue del elif else except finally for from if import in match pass raise return try while with yield',
    memberAfterDot: '',
    load: () => import('monaco-editor/esm/vs/basic-languages/python/python.js')
  },
  r: {
    controlWords: 'break else for function if next repeat return while',
    load: () => import('monaco-editor/esm/vs/basic-languages/r/r.js')
  },
  ruby: {
    controlWords:
      'alias begin break case class def defined? do else elsif end ensure for if in module next redo rescue retry return super then undef unless until when while yield',
    memberAfterDot: '',
    load: () => import('monaco-editor/esm/vs/basic-languages/ruby/ruby.js')
  },
  rust: {
    controlWords: 'await break continue do else for if loop match return try while yield',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/rust/rust.js')
  },
  scala: {
    controlWords: 'catch do else finally for if match return then throw try while yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/scala/scala.js')
  },
  scss: {
    controlRules: AT_RULES,
    load: () => import('monaco-editor/esm/vs/basic-languages/scss/scss.js')
  },
  shell: {
    controlWords:
      'break case continue do done elif else esac fi for if in return select then until while',
    load: () => import('monaco-editor/esm/vs/basic-languages/shell/shell.js')
  },
  sol: {
    controlWords:
      'break continue do else for if import new pragma return returns suicide throw using while',
    load: () => import('monaco-editor/esm/vs/basic-languages/solidity/solidity.js')
  },
  swift: {
    controlWords:
      'await break case catch continue default defer do else fallthrough for guard if import in repeat return switch throw try where while',

    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/swift/swift.js')
  },
  tcl: {
    controlWords: 'break catch continue else elseif exit for foreach if return switch then while',
    load: () => import('monaco-editor/esm/vs/basic-languages/tcl/tcl.js')
  },
  typescript: {
    controlWords:
      'as await break case catch continue default do else export finally for from if import return satisfies switch throw try while with yield',
    memberAfterDot: 'delimiter',
    calls: true,
    load: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js')
  },
  vb: {
    controlWords: 'Case Continue Do Each Else ElseIf For If Return Select Then To Wend While With',
    load: () => import('monaco-editor/esm/vs/basic-languages/vb/vb.js')
  },
  wgsl: {
    controlWords:
      'break case continue continuing default discard else fallthrough for if loop return switch while',
    load: () => import('monaco-editor/esm/vs/basic-languages/wgsl/wgsl.js')
  }
}

/** Theme-accurate tokens for every language in `TOKEN_REFINEMENT_LANGUAGES`, and their colors in
 *  the stock Dark and Light themes. */
export function registerTokenRefinements(
  monaco: Pick<typeof Monaco, 'languages' | 'editor'>
): void {
  for (const [languageId, { load, ...spec }] of Object.entries(TOKEN_REFINEMENT_LANGUAGES)) {
    // Why a factory: it replaces Monaco's own lazy Monarch factory and loads on first use, as that one does.
    monaco.languages.registerTokensProviderFactory(languageId, {
      create: async () => withTokenRefinements((await load()).language, spec)
    })
  }
  // Why the built-in names: Orca's editors all use them, so every setTheme caller stays unchanged.
  monaco.editor.defineTheme('vs-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: REFINED_TOKEN_STOCK_RULES.dark,
    colors: {}
  })
  monaco.editor.defineTheme('vs', {
    base: 'vs',
    inherit: true,
    rules: REFINED_TOKEN_STOCK_RULES.light,
    colors: {}
  })
}
