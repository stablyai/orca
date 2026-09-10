import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readRuntimeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index].trimStart()
    const isRuntimeImport =
      firstLine.startsWith('import ') &&
      !firstLine.startsWith('import type ') &&
      !/^import\s+[\w$]+\s*=\s*require\s*\(/.test(firstLine)
    const isRuntimeReexport =
      (firstLine.startsWith('export {') || firstLine.startsWith('export *')) &&
      !firstLine.startsWith('export type ')
    if (!isRuntimeImport && !isRuntimeReexport) {
      continue
    }
    let statement = firstLine
    while (!/(?:^import\s*['"]|\bfrom\s*['"])/.test(statement) && index + 1 < lines.length) {
      index += 1
      statement += `\n${lines[index]}`
    }
    const match =
      statement.match(/^import\s*['"]([^'"]+)['"]/) ?? statement.match(/\bfrom\s*['"]([^'"]+)['"]/)
    if (match) {
      specifiers.push(match[1])
    }
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1])
  }
  for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1])
  }
  return specifiers
}

function resolveTypeScriptImport(importer: string, specifier: string): string | null {
  const candidate = resolve(dirname(importer), specifier)
  for (const path of [`${candidate}.ts`, `${candidate}.tsx`]) {
    if (existsSync(path)) {
      return path
    }
  }
  return null
}

describe('agent hook listener relay dependency boundary', () => {
  it('detects every supported runtime dependency syntax while excluding type imports', () => {
    const source = [
      "import type { TypeOnly } from './type-only'",
      'import {',
      '  runtime',
      "} from './static-runtime'",
      "import './side-effect'",
      "const dynamic = import('./dynamic-runtime')",
      "export { runtimeExport } from './runtime-export'",
      "export * as runtimeNamespace from './namespace-runtime'",
      "import imported = require('./ts-import-equals')",
      "const required = require('./required-runtime')"
    ].join('\n')

    expect(readRuntimeSpecifiers(source)).toEqual([
      './static-runtime',
      './side-effect',
      './runtime-export',
      './namespace-runtime',
      './dynamic-runtime',
      './ts-import-equals',
      './required-runtime'
    ])
  })

  it('keeps the transitive runtime graph inside Node builtins and shared modules', () => {
    const sharedRoot = resolve(__dirname)
    const listenerPathPrefix = resolve(sharedRoot, 'agent-hook-listener')
    const relayConsumers = [
      resolve(sharedRoot, '../relay/agent-hook-server.ts'),
      resolve(sharedRoot, '../relay/agent-hook-result-retry-scheduler.ts')
    ]
    const pending = relayConsumers.flatMap((consumer) =>
      readRuntimeSpecifiers(readFileSync(consumer, 'utf8'))
        .map((specifier) => resolveTypeScriptImport(consumer, specifier))
        .filter(
          (dependency): dependency is string =>
            dependency === `${listenerPathPrefix}.ts` ||
            dependency?.startsWith(`${listenerPathPrefix}/`) === true
        )
    )
    const seeded = new Set(pending)
    const visited = new Set<string>()
    const forbidden: string[] = []

    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) {
        continue
      }
      visited.add(file)
      const source = readFileSync(file, 'utf8')
      for (const specifier of readRuntimeSpecifiers(source)) {
        if (specifier.startsWith('node:')) {
          continue
        }
        if (!specifier.startsWith('.')) {
          forbidden.push(`${file}: ${specifier}`)
          continue
        }
        const dependency = resolveTypeScriptImport(file, specifier)
        if (!dependency || !dependency.startsWith(sharedRoot)) {
          forbidden.push(`${file}: ${specifier}`)
          continue
        }
        pending.push(dependency)
      }
    }

    expect(forbidden).toEqual([])
    expect([...seeded].map((file) => file.slice(sharedRoot.length + 1)).sort()).toEqual([
      'agent-hook-listener.ts',
      'agent-hook-listener/endpoint-publication.ts',
      'agent-hook-listener/grok-result-discovery.ts',
      'agent-hook-listener/hook-envelope.ts',
      'agent-hook-listener/listener-limits.ts',
      'agent-hook-listener/listener-state.ts',
      'agent-hook-listener/providers/codex-state.ts',
      'agent-hook-listener/request-body.ts',
      'agent-hook-listener/source-routing.ts'
    ])
    expect(
      [...visited].some((file) => file.endsWith('/agent-hook-listener/provider-dispatch.ts'))
    ).toBe(true)
  })
})
