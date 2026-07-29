import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

// Why: token names must exist in Monaco's built-in themes or they render
// unstyled. Plain `operator` is only defined as operator.scss/sql/swift in
// vs-dark, so operators use `keyword.operator`, which falls back to `keyword`.
export const jspMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.jsp',
  ignoreCase: true,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' }
  ],
  tokenizer: {
    root: [
      [/<%--/, 'comment', '@jspComment'],
      [/<%@/, 'metatag', '@jspDirective'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/\$\{/, 'delimiter.curly', '@elExpression'],
      [/<script(?=[\s>])/, 'tag', '@scriptOpen'],
      [/<style(?=[\s>])/, 'tag', '@styleOpen'],
      [/<!--/, 'comment', '@htmlComment'],
      [/<\/?[a-zA-Z][\w.-]*:[\w.-]+/, 'tag', '@tagRest'],
      [/<\/?[a-zA-Z][\w-]*/, 'tag', '@tagRest'],
      [/[^<$]+/, ''],
      [/./, '']
    ],

    htmlComment: [
      [/-->/, 'comment', '@pop'],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],

    jspComment: [
      [/--%>/, 'comment', '@pop'],
      [/[^-]+/, 'comment'],
      [/./, 'comment']
    ],

    // `<%@ page contentType="..." %>` reads as markup, not as Java.
    jspDirective: [
      [/%>/, 'metatag', '@pop'],
      [/[a-zA-Z_][\w.-]*(?=\s*=)/, 'attribute.name'],
      [/[a-zA-Z_][\w.-]*/, 'keyword'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\s+/, 'white'],
      [/./, '']
    ],

    jspScriptlet: [
      [/%>/, 'metatag', '@pop'],
      [/\/\/[^\n]*/, 'comment'],
      [/\/\*/, 'comment', '@javaBlockComment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/\b(?:true|false|null)\b/, 'constant'],
      [
        /\b(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|throws|new|instanceof|import|package|class|public|private|protected|static|final)\b/,
        'keyword'
      ],
      [/\b(?:int|long|short|byte|float|double|boolean|char|void|String|Object|List|Map)\b/, 'type'],
      [/\d[\d_]*\.?[\d_]*(?:[eE][-+]?\d+)?[fFdDlL]?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/[<>=!&|+\-*/%^~?:]+/, 'keyword.operator'],
      [/[;,.]/, 'delimiter'],
      [/[a-zA-Z_$][\w$]*/, 'identifier'],
      [/\s+/, 'white'],
      [/./, '']
    ],

    javaBlockComment: [
      [/\*\//, 'comment', '@pop'],
      [/[^*]+/, 'comment'],
      [/./, 'comment']
    ],

    elExpression: [
      [/\}/, 'delimiter.curly', '@pop'],
      [/\b(?:and|or|not|eq|ne|gt|lt|ge|le|div|mod|empty|instanceof)\b/, 'keyword.operator'],
      [/\b(?:true|false|null)\b/, 'constant'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/\d[\d_]*\.?[\d_]*/, 'number'],
      [/[()[\]]/, '@brackets'],
      [/[<>=!&|+\-*/%?:]+/, 'keyword.operator'],
      [/[,.]/, 'delimiter'],
      [/[a-zA-Z_$][\w$]*/, 'variable'],
      [/\s+/, 'white'],
      [/./, '']
    ],

    // Shared by plain HTML, JSTL and custom tags: attribute values may embed
    // both EL and scriptlet expressions.
    tagRest: [
      [/\/?>/, 'tag', '@pop'],
      [/\$\{/, 'delimiter.curly', '@elExpression'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/[a-zA-Z_:][\w.:-]*(?=\s*=)/, 'attribute.name'],
      [/[a-zA-Z_:][\w.:-]*/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"/, 'attribute.value', '@attributeValueDouble'],
      [/'/, 'attribute.value', '@attributeValueSingle'],
      [/\s+/, 'white'],
      [/./, '']
    ],

    attributeValueDouble: [
      [/"/, 'attribute.value', '@pop'],
      [/\$\{/, 'delimiter.curly', '@elExpression'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/[^"$<]+/, 'attribute.value'],
      [/./, 'attribute.value']
    ],

    attributeValueSingle: [
      [/'/, 'attribute.value', '@pop'],
      [/\$\{/, 'delimiter.curly', '@elExpression'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/[^'$<]+/, 'attribute.value'],
      [/./, 'attribute.value']
    ],

    scriptOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@scriptBody', nextEmbedded: 'javascript' }],
      { include: '@tagRest' }
    ],
    scriptBody: [[/<\/script\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]],

    styleOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@styleBody', nextEmbedded: 'css' }],
      { include: '@tagRest' }
    ],
    styleBody: [[/<\/style\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]]
  }
}

export const jspLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { blockComment: ['<%--', '--%>'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  // Why: `<`/`>` are excluded because scriptlets and EL use them as comparison
  // operators, which would produce false bracket matches.
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

// Why: JSP is HTML plus server-side template syntax — the same shape Monaco
// already serves for Razor and Handlebars. Reusing the HTML language service
// gives tag completion, hovers and folding. Diagnostics and formatting stay off
// because that service does not understand scriptlets and would report them as
// malformed markup.
export const jspHtmlModeConfiguration: Monaco.html.ModeConfiguration = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  links: true,
  documentHighlights: true,
  rename: true,
  colors: true,
  foldingRanges: true,
  selectionRanges: true,
  diagnostics: false,
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false
}

export function registerJspLanguage(monaco: MonacoModule): void {
  const jspAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === 'jsp')
  if (jspAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: 'jsp',
    extensions: ['.jsp', '.jspf'],
    aliases: ['JSP', 'JavaServer Pages']
  })
  monaco.languages.setMonarchTokensProvider('jsp', jspMonarchLanguage)
  monaco.languages.setLanguageConfiguration('jsp', jspLanguageConfiguration)
  monaco.html.registerHTMLLanguageService('jsp', undefined, jspHtmlModeConfiguration)
}
