import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

// Why: `ignoreCase` is off because scriptlets are Java, which is case-sensitive
// — with it on, `List list` colours the variable as a type. Monarch has no
// per-rule casing, so the four HTML tags that genuinely need it spell it out.
//
// Token names must exist in the built-in themes: vs-dark defines
// operator.scss/sql/swift but no plain `operator`, so operators use
// `keyword.operator`, which falls back to `keyword`.
export const jspMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.jsp',
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
      [/[$#]\{/, 'delimiter.curly', '@elExpression'],
      [/<[sS][cC][rR][iI][pP][tT](?=[\s>])/, 'tag', '@scriptOpen'],
      [/<[sS][tT][yY][lL][eE](?=[\s>])/, 'tag', '@styleOpen'],
      [/<!--/, 'comment', '@htmlComment'],
      [/<\/?[a-zA-Z][\w.-]*:[\w.-]+/, 'tag', '@tagRest'],
      [/<\/?[a-zA-Z][\w-]*/, 'tag', '@tagRest'],
      [/[^<$#]+/, '']
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
      [/\s+/, 'white']
    ],

    // Covers `<% %>`, `<%= %>` and `<%! %>`; all three need the same Java tokens.
    jspScriptlet: [
      [/%>/, 'metatag', '@pop'],
      [/\/\/(?:(?!%>)[^\n])*/, 'comment'],
      [/\/\*/, 'comment', '@javaBlockComment'],
      // JSP closes scriptlets before parsing Java, including inside literals.
      [/"(?:(?!%>)(?:[^"\\]|\\.))*(?:"|(?=%>))/, 'string'],
      [/'(?:(?!%>)(?:[^'\\]|\\.))*(?:'|(?=%>))/, 'string'],
      [/\b(?:true|false|null)\b/, 'constant'],
      [
        /\b(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|throws|new|instanceof|import|package|class|interface|enum|extends|implements|public|private|protected|static|final|abstract|synchronized|assert|this|super)\b/,
        'keyword'
      ],
      [
        /\b(?:int|long|short|byte|float|double|boolean|char|void|String|Object|List|Map|Set|Iterator|Optional|ArrayList|LinkedList|HashMap|LinkedHashMap|HashSet|LinkedHashSet|TreeMap|TreeSet|StringBuilder|BigDecimal|BigInteger|Integer|Long|Double|Boolean|Short|Byte|Float|Character|Void)\b/,
        'type'
      ],
      [/\d[\d_]*\.?[\d_]*(?:[eE][-+]?\d+)?[fFdDlL]?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      // Why: `%` is split out with a lookahead so a run like `i++%>` cannot
      // swallow the closing `%>` and leak Java tokenization to end of file.
      [/%(?!>)|[<>=!&|+\-*/^~?:]+/, 'keyword.operator'],
      [/[;,.]/, 'delimiter'],
      [/[a-zA-Z_$][\w$]*/, 'identifier'],
      [/\s+/, 'white']
    ],

    javaBlockComment: [
      [/%>/, 'metatag', '@popall'],
      [/\*\//, 'comment', '@pop'],
      [/(?:(?!%>)[^*])+/, 'comment'],
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
      // `fn:length(x)` — the namespace colon is a separator, not an operator.
      [/:(?=[a-zA-Z_])/, 'delimiter'],
      [/[<>=!&|+\-*/%?:]+/, 'keyword.operator'],
      [/[,.]/, 'delimiter'],
      [/[a-zA-Z_$][\w$]*/, 'variable'],
      [/\s+/, 'white']
    ],

    // Shared by plain HTML, JSTL and custom tags: attribute values may embed
    // both EL and scriptlet expressions.
    tagRest: [
      [/\/?>/, 'tag', '@pop'],
      [/<%--/, 'comment', '@jspComment'],
      [/[$#]\{/, 'delimiter.curly', '@elExpression'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/[a-zA-Z_:][\w.:-]*/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"/, 'attribute.value', '@attributeValueDouble'],
      [/'/, 'attribute.value', '@attributeValueSingle'],
      [/\s+/, 'white']
    ],

    attributeValueDouble: [
      [/"/, 'attribute.value', '@pop'],
      [/<%--/, 'comment', '@jspComment'],
      [/[$#]\{/, 'delimiter.curly', '@elExpression'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/[^"$#<]+/, 'attribute.value'],
      [/./, 'attribute.value']
    ],

    attributeValueSingle: [
      [/'/, 'attribute.value', '@pop'],
      [/<%--/, 'comment', '@jspComment'],
      [/[$#]\{/, 'delimiter.curly', '@elExpression'],
      [/<%[=!]?/, 'metatag', '@jspScriptlet'],
      [/[^'$#<]+/, 'attribute.value'],
      [/./, 'attribute.value']
    ],

    scriptOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@scriptBody', nextEmbedded: 'javascript' }],
      { include: '@tagRest' }
    ],
    scriptBody: [
      [/<\/[sS][cC][rR][iI][pP][tT]\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]
    ],

    styleOpen: [
      [/\/>/, 'tag', '@pop'],
      [/>/, { token: 'tag', switchTo: '@styleBody', nextEmbedded: 'css' }],
      { include: '@tagRest' }
    ],
    styleBody: [
      [/<\/[sS][tT][yY][lL][eE]\s*>/, { token: 'tag', next: '@pop', nextEmbedded: '@pop' }]
    ]
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
// already serves for Razor and Handlebars. Only the ten keys below are read by
// the HTML mode. Formatting and rename are off because both act on a parse of
// the file as HTML, and `<% ... %>` is not markup: formatting would move it and
// rename would edit spans derived from a mis-parse.
export const jspHtmlModeConfiguration: Monaco.html.ModeConfiguration = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  links: true,
  documentHighlights: true,
  selectionRanges: true,
  foldingRanges: true,
  rename: false,
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
  // Why: registering twice would create a second worker and provider set —
  // the call has no internal dedupe — so it stays behind the guard above.
  monaco.html.registerHTMLLanguageService('jsp', undefined, jspHtmlModeConfiguration)
}
