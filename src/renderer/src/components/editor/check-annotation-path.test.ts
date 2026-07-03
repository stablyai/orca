import { describe, expect, it } from 'vitest'
import {
  getOpenableAnnotationLine,
  resolveAnnotationPathInsideWorktree
} from './check-annotation-path'
import type { PRCheckAnnotation } from '../../../../shared/types'

function annotation(path: string | null, startLine = 1): PRCheckAnnotation {
  return {
    path,
    startLine,
    endLine: startLine,
    annotationLevel: null,
    title: null,
    message: '',
    rawDetails: null
  }
}

describe('getOpenableAnnotationLine', () => {
  it('allows extensionless repo files and dotfiles', () => {
    expect(getOpenableAnnotationLine(annotation('Dockerfile'))).toEqual({
      path: 'Dockerfile',
      line: 1
    })
    expect(getOpenableAnnotationLine(annotation('LICENSE'))).toEqual({ path: 'LICENSE', line: 1 })
    expect(getOpenableAnnotationLine(annotation('.eslintrc'))).toEqual({
      path: '.eslintrc',
      line: 1
    })
  })

  it('rejects workflow pseudo-paths without blocking workflow files', () => {
    expect(getOpenableAnnotationLine(annotation('.github'))).toBeNull()
    expect(getOpenableAnnotationLine(annotation('.github/workflows/ci.yml'))).toEqual({
      path: '.github/workflows/ci.yml',
      line: 1
    })
  })
})

describe('resolveAnnotationPathInsideWorktree', () => {
  it('normalizes safe relative paths inside the worktree', () => {
    expect(resolveAnnotationPathInsideWorktree('/repo', 'src/../Dockerfile')).toEqual({
      absolutePath: '/repo/Dockerfile',
      relativePath: 'Dockerfile'
    })
    expect(resolveAnnotationPathInsideWorktree('/repo', ' LICENSE ')).toEqual({
      absolutePath: '/repo/LICENSE',
      relativePath: 'LICENSE'
    })
  })

  it('rejects paths that escape or start outside the worktree', () => {
    expect(resolveAnnotationPathInsideWorktree('/repo', '.github')).toBeNull()
    expect(resolveAnnotationPathInsideWorktree('/repo', '../../tmp/secret.txt')).toBeNull()
    expect(resolveAnnotationPathInsideWorktree('/repo', '/tmp/secret.txt')).toBeNull()
    expect(resolveAnnotationPathInsideWorktree('C:\\Repo', 'D:\\secret.txt')).toBeNull()
  })
})
