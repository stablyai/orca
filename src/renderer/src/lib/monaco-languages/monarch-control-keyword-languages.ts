import type * as Monaco from 'monaco-editor'
import { withControlKeywords, type ControlKeywordSpec } from './monarch-control-keywords'

type ControlKeywordLanguage = ControlKeywordSpec & {
  load: () => Promise<{ language: Monaco.languages.IMonarchLanguage }>
}

// Rules whose regex starts a C preprocessor directive (`#include`, `#define`).
const DIRECTIVE_RULES = /^\^\\s\*#/
// Rules whose regex starts a CSS at-rule (`@import`, `@media`).
const AT_RULES = /^\[@\]/

/** Monaco's languages whose control keywords VS Code themes color apart from other keywords,
 *  with the words VS Code's grammar for each language scopes `keyword.control`. */
export const CONTROL_KEYWORD_LANGUAGES: Record<string, ControlKeywordLanguage> = {
  apex: {
    keywords: 'break catch continue do else finally for goto if return throw try when while',
    load: () => import('monaco-editor/esm/vs/basic-languages/apex/apex.js')
  },
  bicep: {
    keywords: 'existing for if in module output param resource targetScope var',
    load: () => import('monaco-editor/esm/vs/basic-languages/bicep/bicep.js')
  },
  c: {
    keywords:
      'break case catch continue default delete do else for goto if new operator return switch throw try using while',
    controlRules: DIRECTIVE_RULES,
    load: () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.js')
  },
  clojure: {
    keywords:
      'declare def definline definterface defmacro defmethod defmulti defn defn- defonce defprotocol defrecord defstruct deftype import in-ns ns require use',
    load: () => import('monaco-editor/esm/vs/basic-languages/clojure/clojure.js')
  },
  coffeescript: {
    keywords:
      'break by catch continue delete do else extends finally for if in loop of return switch then throw try unless until when while',
    memberAfterDot: 'delimiter',
    load: () => import('monaco-editor/esm/vs/basic-languages/coffee/coffee.js')
  },
  cpp: {
    keywords:
      'break case catch continue default delete do else for goto if new operator return switch throw try using while',
    controlRules: DIRECTIVE_RULES,
    load: () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.js')
  },
  csharp: {
    keywords:
      'break catch checked continue do else finally fixed for foreach goto if in lock return switch throw try unchecked using while',
    load: () => import('monaco-editor/esm/vs/basic-languages/csharp/csharp.js')
  },
  css: {
    controlRules: AT_RULES,
    load: () => import('monaco-editor/esm/vs/basic-languages/css/css.js')
  },
  cypher: {
    keywords:
      'AS CALL CASE DISTINCT ELSE END LIMIT MATCH RETURN SKIP THEN UNION UNWIND WHEN WHERE WITH YIELD',
    load: () => import('monaco-editor/esm/vs/basic-languages/cypher/cypher.js')
  },
  dart: {
    keywords:
      'assert async await break case catch continue default do else finally for if in on rethrow return switch sync throw try while yield',

    load: () => import('monaco-editor/esm/vs/basic-languages/dart/dart.js')
  },
  elixir: {
    keywords:
      'after alias case catch cond defexception defimpl defmodule defprotocol defstruct do else end fn for if import quote raise receive require rescue super throw try unless unquote use with',
    load: () => import('monaco-editor/esm/vs/basic-languages/elixir/elixir.js')
  },
  fsharp: {
    keywords: 'do elif else finally for if in match return then try while with yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/fsharp/fsharp.js')
  },
  go: {
    keywords:
      'break case continue default defer else fallthrough for go goto if import range return select switch',
    load: () => import('monaco-editor/esm/vs/basic-languages/go/go.js')
  },
  java: {
    keywords:
      'assert break case catch continue default do else finally for if new return switch throw try while yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/java/java.js')
  },
  javascript: {
    keywords:
      'await break case catch continue default do else export finally for from if import return switch throw try while with yield',
    memberAfterDot: 'delimiter',
    load: () => import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js')
  },
  julia: {
    keywords:
      'begin break catch continue do else elseif end export finally for if import let return try using while',
    load: () => import('monaco-editor/esm/vs/basic-languages/julia/julia.js')
  },
  kotlin: {
    keywords: 'break continue do else for if return throw try when while',
    load: () => import('monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js')
  },
  lua: {
    keywords: 'break do else elseif end for function goto if in repeat return then until while',
    load: () => import('monaco-editor/esm/vs/basic-languages/lua/lua.js')
  },
  'objective-c': {
    keywords:
      '#define #if #ifdef #ifndef #import #include #undef break continue do else for goto if return switch while',
    load: () => import('monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js')
  },
  pascal: {
    keywords: 'abort break continue do exit for raise repeat until while',
    load: () => import('monaco-editor/esm/vs/basic-languages/pascal/pascal.js')
  },
  perl: {
    keywords:
      'continue die do else elsif eval exit for foreach goto if last next redo require return select unless until use wait while',
    load: () => import('monaco-editor/esm/vs/basic-languages/perl/perl.js')
  },
  php: {
    keywords:
      'break case catch continue declare default die do else elseif enddeclare endfor endforeach endif endswitch endwhile exit for foreach if include include_once require require_once return switch throw try while yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/php/php.js')
  },
  powerquery: {
    keywords: 'else if otherwise then try',
    load: () => import('monaco-editor/esm/vs/basic-languages/powerquery/powerquery.js')
  },
  powershell: {
    keywords:
      'begin break catch continue data define do dynamicparam else elseif end exit finally for foreach from if in inlinescript parallel param process return sequence switch throw trap try until var while',
    memberAfterDot: 'delimiter',
    load: () => import('monaco-editor/esm/vs/basic-languages/powershell/powershell.js')
  },
  python: {
    keywords:
      'as assert async await break case continue del elif else except finally for from if import in match pass raise return try while with yield',
    memberAfterDot: '',
    load: () => import('monaco-editor/esm/vs/basic-languages/python/python.js')
  },
  r: {
    keywords: 'break else for function if next repeat return while',
    load: () => import('monaco-editor/esm/vs/basic-languages/r/r.js')
  },
  ruby: {
    keywords:
      'alias begin break case class def defined? do else elsif end ensure for if in module next redo rescue retry return super then undef unless until when while yield',
    memberAfterDot: '',
    load: () => import('monaco-editor/esm/vs/basic-languages/ruby/ruby.js')
  },
  rust: {
    keywords: 'await break continue do else for if loop match return try while yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/rust/rust.js')
  },
  scala: {
    keywords: 'catch do else finally for if match return then throw try while yield',
    load: () => import('monaco-editor/esm/vs/basic-languages/scala/scala.js')
  },
  scss: {
    controlRules: AT_RULES,
    load: () => import('monaco-editor/esm/vs/basic-languages/scss/scss.js')
  },
  shell: {
    keywords:
      'break case continue do done elif else esac fi for if in return select then until while',
    load: () => import('monaco-editor/esm/vs/basic-languages/shell/shell.js')
  },
  sol: {
    keywords:
      'break continue do else for if import new pragma return returns suicide throw using while',
    load: () => import('monaco-editor/esm/vs/basic-languages/solidity/solidity.js')
  },
  swift: {
    keywords:
      'await break case catch continue default defer do else fallthrough for guard if import in repeat return switch throw try where while',

    load: () => import('monaco-editor/esm/vs/basic-languages/swift/swift.js')
  },
  tcl: {
    keywords: 'break catch continue else elseif exit for foreach if return switch then while',
    load: () => import('monaco-editor/esm/vs/basic-languages/tcl/tcl.js')
  },
  typescript: {
    keywords:
      'as await break case catch continue default do else export finally for from if import return satisfies switch throw try while with yield',
    memberAfterDot: 'delimiter',
    load: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js')
  },
  vb: {
    keywords: 'Case Continue Do Each Else ElseIf For If Return Select Then To Wend While With',
    load: () => import('monaco-editor/esm/vs/basic-languages/vb/vb.js')
  },
  wgsl: {
    keywords:
      'break case continue continuing default discard else fallthrough for if loop return switch while',
    load: () => import('monaco-editor/esm/vs/basic-languages/wgsl/wgsl.js')
  }
}

/** VS Code-style control keyword colors for every language in `CONTROL_KEYWORD_LANGUAGES`. */
export function registerControlKeywordTokens(monaco: Pick<typeof Monaco, 'languages'>): void {
  for (const [languageId, { load, ...spec }] of Object.entries(CONTROL_KEYWORD_LANGUAGES)) {
    // Why a factory: it replaces Monaco's own lazy Monarch factory and loads on first use, as that one does.
    monaco.languages.registerTokensProviderFactory(languageId, {
      create: async () => withControlKeywords((await load()).language, spec)
    })
  }
}
