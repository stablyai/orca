import { describe, expect, it } from 'vitest'
import { parseMissingSharedLibrary } from './missing-shared-library'

describe('parseMissingSharedLibrary', () => {
  it('names the shared object the loader could not open, on either loader', () => {
    expect(
      parseMissingSharedLibrary(
        'libstdc++.so.6: cannot open shared object file: No such file or directory'
      )
    ).toBe('libstdc++.so.6')
    expect(parseMissingSharedLibrary('Library not loaded: /usr/local/lib/libfoo.dylib')).toBe(
      '/usr/local/lib/libfoo.dylib'
    )
    // A symbol version that is absent is a rebuild, not an install: must not match here.
    expect(parseMissingSharedLibrary("/lib/libc.so.6: version `GLIBC_2.34' not found")).toBeNull()
    // A library that is present but built for another arch can't be fixed by installing it.
    expect(
      parseMissingSharedLibrary(
        'electron: error while loading shared libraries: libnss3.so: wrong ELF class: ELFCLASS32'
      )
    ).toBeNull()
  })
})
