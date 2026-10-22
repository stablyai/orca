import { expect, it } from 'vitest'
import {
  isExternalEditorFileDeepLink,
  isExternalEditorUriScheme
} from './external-editor-uri-schemes'

it('accepts vscode and vscode-insiders file deep links', () => {
  expect(isExternalEditorFileDeepLink(new URL('vscode://file/D:/src/project/Example.cs:120'))).toBe(
    true
  )
  expect(
    isExternalEditorFileDeepLink(new URL('vscode-insiders://file/D:/src/project/Example.cs:120'))
  ).toBe(true)
})

it('rejects a vscode link that targets an extension handler instead of a file', () => {
  expect(isExternalEditorFileDeepLink(new URL('vscode://some-extension-id/do-something'))).toBe(
    false
  )
})

it('rejects a file-hostname vscode link smuggling credentials or a port', () => {
  expect(
    isExternalEditorFileDeepLink(new URL('vscode://user@file/D:/src/project/Example.cs:120'))
  ).toBe(false)
  expect(
    isExternalEditorFileDeepLink(new URL('vscode://user:pass@file/D:/src/project/Example.cs:120'))
  ).toBe(false)
  expect(
    isExternalEditorFileDeepLink(new URL('vscode://file:8080/D:/src/project/Example.cs:120'))
  ).toBe(false)
})

it('rejects schemes other than vscode/vscode-insiders', () => {
  expect(isExternalEditorUriScheme('https:')).toBe(false)
  expect(isExternalEditorUriScheme('file:')).toBe(false)
  expect(isExternalEditorUriScheme('vscode:')).toBe(true)
  expect(isExternalEditorUriScheme('vscode-insiders:')).toBe(true)
})
