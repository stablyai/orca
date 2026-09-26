import type { PerforceOperationResult } from './perforce-types'
import { runP4, runP4OrThrow } from './p4-command'
import { fileArgs, toResult } from './perforce-mutations'

export async function shelveChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['shelve', '-f', '-c', String(changelist)], { cwd }))
}

export function buildChangeSpec(
  template: string,
  description: string,
  options: { dropFiles: boolean } = { dropFiles: true }
): string {
  const indented = description
    .trim()
    .split(/\r?\n/)
    .map((line) => `\t${line}`)
    .join('\n')
  const lines = template.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      skipping = false
    }
    if (line.startsWith('Description:')) {
      out.push('Description:', indented)
      skipping = true
    } else if (options.dropFiles && line.startsWith('Files:')) {
      // Files move via `reopen`, so a new changelist starts empty.
      skipping = true
    } else if (!skipping) {
      out.push(line)
    }
  }
  return `${out.join('\n')}\n`
}

/** Creates a numbered changelist and moves the given files into it. */
export async function createChangelistWithFiles(
  cwd: string,
  description: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult & { changelist?: number }> {
  const template = await runP4OrThrow(['change', '-o'], { cwd })
  const created = await runP4(['change', '-i'], {
    cwd,
    input: buildChangeSpec(template, description)
  })
  const match = /Change (\d+) created/.exec(created.stdout)
  if (created.code !== 0 || !match) {
    return toResult(created)
  }
  const changelist = Number(match[1])
  if (filePaths.length > 0) {
    const moved = await moveFilesToChangelist(cwd, filePaths, changelist)
    if (!moved.success) {
      return { ...moved, changelist }
    }
  }
  return { success: true, output: created.stdout.trim(), changelist }
}

export async function moveFilesToChangelist(
  cwd: string,
  filePaths: readonly string[],
  changelist: number | 'default'
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(['reopen', '-c', String(changelist), ...fileArgs(filePaths)], { cwd })
  )
}

export async function deleteEmptyChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['change', '-d', String(changelist)], { cwd }))
}

export async function editChangelistDescription(
  cwd: string,
  changelist: number,
  description: string
): Promise<PerforceOperationResult> {
  const template = await runP4OrThrow(['change', '-o', String(changelist)], { cwd })
  return toResult(
    await runP4(['change', '-i'], {
      cwd,
      input: buildChangeSpec(template, description, { dropFiles: false })
    })
  )
}

/** Restores a changelist's shelved files into the same changelist, overwriting workspace copies. */
export async function unshelveChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(['unshelve', '-f', '-s', String(changelist), '-c', String(changelist)], { cwd })
  )
}

export async function deleteShelf(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['shelve', '-d', '-c', String(changelist)], { cwd }))
}
