import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const openIdeaDarkHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: '#cf8e6d' },
  { tag: [t.string, t.special(t.string)], color: '#6aab73' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#7a7e85', fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], color: '#2aacb8' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#56a8f5' },
  { tag: [t.definition(t.variableName), t.variableName], color: '#bcbec4' },
  { tag: [t.typeName, t.className, t.namespace], color: '#b3ae60' },
  { tag: [t.propertyName, t.attributeName], color: '#c77dbb' },
  { tag: [t.operator, t.punctuation], color: '#9ca3af' },
  { tag: [t.tagName], color: '#d5b778' },
  { tag: [t.heading], color: '#56a8f5', fontWeight: '600' },
  { tag: [t.invalid], color: '#f75464', textDecoration: 'underline wavy' }
])

export const openIdeaLightHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: '#0033b3' },
  { tag: [t.string, t.special(t.string)], color: '#067d17' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8c8c8c', fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], color: '#1750eb' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#00627a' },
  { tag: [t.definition(t.variableName), t.variableName], color: '#080808' },
  { tag: [t.typeName, t.className, t.namespace], color: '#000000', fontWeight: '500' },
  { tag: [t.propertyName, t.attributeName], color: '#871094' },
  { tag: [t.operator, t.punctuation], color: '#5c6370' },
  { tag: [t.tagName], color: '#0033b3' },
  { tag: [t.heading], color: '#0033b3', fontWeight: '600' },
  { tag: [t.invalid], color: '#c41a16', textDecoration: 'underline wavy' }
])
