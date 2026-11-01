import { describe, expect, it } from 'vitest'
import { detectLanguage } from './editor-language-detect'

describe('detectLanguage', () => {
  it.each([
    ['Jenkinsfile.md', 'markdown'],
    ['build.gradle.kts', 'kotlin'],
    ['MyJenkinsfileNotes', 'plaintext']
  ])('keeps %s off Groovy', (filePath, language) => {
    expect(detectLanguage(filePath)).toBe(language)
  })
  it.each([
    ['.env', 'dotenv'],
    ['.env.local', 'dotenv'],
    ['.env.development', 'dotenv'],
    ['.env.production', 'dotenv'],
    ['.env.functions.local', 'dotenv'],
    ['.env.staging', 'dotenv'],
    ['.env.test.example', 'dotenv'],
    ['config/.env.development.local', 'dotenv'],
    ['.ENV', 'dotenv'],
    ['.ENV.STAGING', 'dotenv'],
    ['C:\\repo\\.EnV.FUNCTIONS.LOCAL', 'dotenv'],
    ['\\\\server\\share\\.env.test.example', 'dotenv'],
    ['.env.sh', 'shell'],
    ['.ENV.SH', 'shell'],
    ['.env.json', 'json'],
    ['.env.local.ts', 'typescript'],
    ['.env/CMakeLists.txt', 'cmake'],
    ['C:\\repo\\.env.local\\Dockerfile', 'dockerfile'],
    ['.envrc', 'shell'],
    ['.ENVRC', 'shell'],
    ['.environment', 'plaintext'],
    ['env.staging', 'plaintext'],
    ['dev.env', 'dotenv'],
    ['config/prod.ENV', 'dotenv'],
    ['C:\\repo\\staging.env', 'dotenv'],
    ['other.env.local', 'plaintext'],
    ['..env.local', 'plaintext'],
    ['.env.staging/readme', 'plaintext'],
    ['C:\\repo\\.env.local\\notes', 'plaintext'],
    ['', 'plaintext']
  ])('detects dotenv names without overriding specific mappings: %s', (filePath, expected) => {
    expect(detectLanguage(filePath)).toBe(expected)
  })

  it.each([
    ['/Users/me/.ZSHRC', 'shell'],
    ['C:\\Users\\me\\.BASHRC', 'shell'],
    ['/home/me/.Bash_Profile', 'shell'],
    ['/home/me/.PROFILE', 'shell'],
    ['/home/me/.ZPROFILE', 'shell'],
    ['C:\\repo\\DOCKERFILE', 'dockerfile'],
    ['C:\\repo\\dockerfile', 'dockerfile'],
    ['C:\\repo\\MAKEFILE', 'makefile'],
    ['C:\\repo\\makefile', 'makefile'],
    ['C:\\repo\\CMAKELISTS.TXT', 'cmake'],
    ['C:\\repo\\.GITIGNORE', 'ini']
  ])('maps exact filenames case-insensitively: %s', (filePath, expected) => {
    expect(detectLanguage(filePath)).toBe(expected)
  })
  it.each([
    ['#!/usr/bin/python3\n', 'python'],
    ['#!/usr/bin/env bash\necho hi', 'shell'],
    ['#! /bin/sh -e\n', 'shell'],
    ['#!/usr/bin/env -S node --flag', 'javascript'],
    ['#!C:\\Python\\python.exe\n', 'python'],
    ['#!/usr/bin/env python3.12', 'python'],
    ['#!/usr/bin/ruby\r\nputs 1', 'ruby'],
    ['#!/usr/bin/env groovy\n', 'groovy'],
    ['#!/usr/bin/env awk', 'plaintext'],
    ['#!/usr/bin/env toString', 'plaintext'],
    ['#!/usr/bin/__proto__', 'plaintext'],
    ['echo hi\n#!/bin/sh', 'plaintext']
  ])('falls back to the shebang for extensionless files: %j', (content, expected) => {
    expect(detectLanguage('bin/tool', content)).toBe(expected)
  })

  it('only applies the shebang to extensionless names', () => {
    expect(detectLanguage('script.rb', '#!/usr/bin/env python3')).toBe('ruby')
    expect(detectLanguage('Makefile', '#!/usr/bin/env python3')).toBe('makefile')
    expect(detectLanguage('notes.txt', '#!/usr/bin/env python3')).toBe('plaintext')
  })
})
