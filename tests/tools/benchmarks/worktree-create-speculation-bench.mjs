#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

function parseArgs(argv) {
  const options = { repo: process.cwd(), base: 'HEAD', iterations: 5 }
  const firstFlag = argv.findIndex((value, index) => index > 0 && value.startsWith('--'))
  for (let index = firstFlag === -1 ? argv.length : firstFlag; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--repo' && value) {
      options.repo = path.resolve(value)
    } else if (flag === '--base' && value) {
      options.base = value
    } else if (flag === '--iterations' && value && Number.isInteger(Number(value))) {
      options.iterations = Number(value)
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`)
    }
    index += 1
  }
  if (options.iterations < 1) {
    throw new Error('--iterations must be positive')
  }
  return options
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function time(operation) {
  const startedAt = performance.now()
  operation()
  return performance.now() - startedAt
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function summarize(samples) {
  return {
    medianMs: Number(median(samples).toFixed(1)),
    minMs: Number(Math.min(...samples).toFixed(1)),
    maxMs: Number(Math.max(...samples).toFixed(1)),
    samplesMs: samples.map((sample) => Number(sample.toFixed(1)))
  }
}

function removeWorktree(repo, worktreePath, branch, locked = false) {
  if (locked) {
    git(repo, ['worktree', 'unlock', worktreePath])
  }
  git(repo, ['worktree', 'remove', '--force', worktreePath])
  if (branch) {
    git(repo, ['branch', '-D', branch])
  }
}

function benchmark(options) {
  const repo = git(options.repo, ['rev-parse', '--show-toplevel'])
  const base = git(repo, ['rev-parse', '--verify', `${options.base}^{commit}`])
  const retargetBase = git(repo, ['rev-parse', '--verify', `${base}~20^{commit}`])
  const scratchRoot = mkdtempSync(path.join(path.dirname(repo), '.orca-create-bench-'))
  const samples = { baseline: [], prepare: [], submit: [], retarget: [], cancel: [] }
  const prefix = `orca-create-bench-${process.pid}-${Date.now()}`

  try {
    for (let index = 0; index < options.iterations; index += 1) {
      const baselinePath = path.join(scratchRoot, `baseline-${index}`)
      const baselineBranch = `${prefix}-baseline-${index}`
      samples.baseline.push(
        time(() =>
          git(repo, ['worktree', 'add', '--no-track', '-b', baselineBranch, baselinePath, base])
        )
      )
      removeWorktree(repo, baselinePath, baselineBranch)

      const preparedPath = path.join(scratchRoot, `prepared-${index}`)
      const finalPath = path.join(scratchRoot, `final-${index}`)
      const finalBranch = `${prefix}-final-${index}`
      samples.prepare.push(
        time(() => {
          git(repo, ['worktree', 'add', '--detach', '--no-checkout', preparedPath, base])
          git(preparedPath, ['reset', '--hard', base])
          git(repo, [
            'worktree',
            'lock',
            '--reason',
            `orca-create-preparation:v1:${process.pid}:${index}`,
            preparedPath
          ])
        })
      )
      samples.submit.push(
        time(() => {
          const targetHead = git(repo, ['rev-parse', '--verify', `${base}^{commit}`])
          git(preparedPath, ['rev-parse', '--verify', 'HEAD'])
          git(repo, ['worktree', 'move', '-f', '-f', preparedPath, finalPath])
          git(finalPath, ['checkout', '--no-track', '-b', finalBranch, targetHead])
          git(repo, ['worktree', 'unlock', finalPath])
        })
      )
      removeWorktree(repo, finalPath, finalBranch)

      const retargetPath = path.join(scratchRoot, `retarget-${index}`)
      git(repo, ['worktree', 'add', '--detach', '--no-checkout', retargetPath, base])
      git(retargetPath, ['reset', '--hard', base])
      git(repo, ['worktree', 'lock', '--reason', 'orca-create-preparation:v1:bench', retargetPath])
      samples.retarget.push(time(() => git(retargetPath, ['reset', '--hard', retargetBase])))
      removeWorktree(repo, retargetPath, undefined, true)

      const cancelledPath = path.join(scratchRoot, `cancel-${index}`)
      git(repo, ['worktree', 'add', '--detach', '--no-checkout', cancelledPath, base])
      git(cancelledPath, ['reset', '--hard', base])
      git(repo, ['worktree', 'lock', '--reason', 'orca-create-preparation:v1:bench', cancelledPath])
      samples.cancel.push(time(() => removeWorktree(repo, cancelledPath, undefined, true)))
    }
  } finally {
    rmSync(scratchRoot, { force: true, recursive: true })
    git(repo, ['worktree', 'prune'])
  }

  return {
    platform: `${process.platform}-${process.arch}`,
    os: os.release(),
    gitVersion: git(repo, ['--version']),
    repo,
    trackedFiles: Number(git(repo, ['ls-files']).split('\n').filter(Boolean).length),
    iterations: options.iterations,
    base,
    retargetBase,
    baselineSubmit: summarize(samples.baseline),
    speculativePrepare: summarize(samples.prepare),
    speculativeSubmit: summarize(samples.submit),
    changeBaseAfterPrepare: summarize(samples.retarget),
    cancelPrepared: summarize(samples.cancel)
  }
}

console.log(JSON.stringify(benchmark(parseArgs(process.argv)), null, 2))
