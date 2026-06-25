import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

export type IsolatedLargeDiffRepo = {
  repoPath: string
  relativePath: string
  absolutePath: string
}

export type IsolatedStagedLocaleDiffRepo = {
  repoPath: string
  relativePaths: string[]
}

function runGit(repoPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
}

export function createIsolatedLargeDiffRepo(): IsolatedLargeDiffRepo {
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-large-diff-repro-')))
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])

  mkdirSync(path.join(repoPath, 'src'), { recursive: true })
  const relativePath = path.join('src', `large-diff-${randomUUID()}.ts`)
  const absolutePath = path.join(repoPath, relativePath)
  writeFileSync(absolutePath, 'export const seed = 1\n')
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial large diff repro fixture'])

  return { repoPath, relativePath, absolutePath }
}

export function buildLargeTypeScriptFile(lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(`export const largeDiffValue${i} = ${i}`)
  }
  return `${lines.join('\n')}\n`
}

function buildLocaleLikeJson(fileIndex: number, entryCount: number): string {
  const lines = ['{']
  for (let i = 0; i < entryCount; i += 1) {
    const value = `locale ${fileIndex} original ${i} `.repeat(5).trim()
    const comma = i + 1 === entryCount ? '' : ','
    lines.push(`  "entry_${String(i).padStart(5, '0')}": "${value}"${comma}`)
  }
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function modifyLocaleLikeJson(content: string, fileIndex: number): string {
  const lines = content.split('\n')
  const changedLineIndex = 3200 + fileIndex
  lines[changedLineIndex] = lines[changedLineIndex].replace('original', 'updated')
  lines.splice(changedLineIndex + 4, 1)
  return lines.join('\n')
}

export function createIsolatedStagedLocaleDiffRepo(): IsolatedStagedLocaleDiffRepo {
  const repoPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-staged-locale-repro-')))
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoPath, ['config', 'user.name', 'E2E Test'])

  mkdirSync(path.join(repoPath, 'src', 'locales'), { recursive: true })
  const toAbsoluteFsPath = (relativePosixPath: string): string =>
    path.join(repoPath, ...relativePosixPath.split(path.posix.sep))
  const relativePaths: string[] = []
  for (let fileIndex = 0; fileIndex < 5; fileIndex += 1) {
    const relativePath = path.posix.join('src', 'locales', `locale-${fileIndex}.json`)
    const absolutePath = toAbsoluteFsPath(relativePath)
    const original = buildLocaleLikeJson(fileIndex, 3600)
    writeFileSync(absolutePath, original)
    relativePaths.push(relativePath)
  }
  runGit(repoPath, ['add', '-A'])
  runGit(repoPath, ['commit', '-m', 'Initial locale fixture'])

  for (let fileIndex = 0; fileIndex < relativePaths.length; fileIndex += 1) {
    const absolutePath = toAbsoluteFsPath(relativePaths[fileIndex])
    const original = buildLocaleLikeJson(fileIndex, 3600)
    writeFileSync(absolutePath, modifyLocaleLikeJson(original, fileIndex))
  }
  runGit(repoPath, ['add', '-A'])

  return { repoPath, relativePaths }
}
