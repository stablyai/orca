import { describe, expect, it } from 'vitest'
import { enclosingGitRootOfChildFolder } from './nested-repo-child-folder'

describe('enclosingGitRootOfChildFolder', () => {
  it('reports the root only for a strict child folder, across path spellings', () => {
    const child = (selectedPath: string, gitRootPath: string) =>
      enclosingGitRootOfChildFolder({ selectedPath, selectedPathKind: 'git_repo', gitRootPath })

    // Git prints forward slashes on Windows while pickers return backslashes.
    expect(child('C:\\Courses\\DSC102\\PA4', 'C:/Courses')).toBe('C:/Courses')
    expect(child('C:\\Courses\\', 'c:/courses')).toBeNull()
    expect(child('/home/me/courses/dsc102', '/home/me/courses')).toBe('/home/me/courses')
    expect(child('/home/me/courses', '/home/me/courses')).toBeNull()
    // A sibling sharing a name prefix is not a child.
    expect(child('/home/me/courses-old/a', '/home/me/courses')).toBeNull()
    expect(
      enclosingGitRootOfChildFolder({
        selectedPath: '/home/me/courses/a',
        selectedPathKind: 'non_git_folder',
        gitRootPath: '/home/me/courses'
      })
    ).toBeNull()
  })
})
