import { describe, expect, it } from 'vitest'
import { ipykernelInstallCommand, venvSetupCommand } from './ipynb-kernel-setup-commands'

describe('copyable setup commands', () => {
  it('quotes the install command for POSIX shells and PowerShell', () => {
    const posix = (path: string): string => ipykernelInstallCommand(path, false)
    const windows = (path: string): string => ipykernelInstallCommand(path, true)
    const pip = ' -m pip install -U ipykernel'
    expect(posix('/v/bin/python')).toBe(`'/v/bin/python'${pip}`)
    expect(posix('/my env/bin/python')).toBe(`'/my env/bin/python'${pip}`)
    expect(posix('/Dev&Test/bin/python')).toBe(`'/Dev&Test/bin/python'${pip}`)
    expect(posix("/Bob's/bin/python")).toBe(`'/Bob'\\''s/bin/python'${pip}`)
    expect(windows('C:\\My Env\\python.exe')).toBe(`& 'C:\\My Env\\python.exe'${pip}`)
    expect(windows('C:\\Dev&Test\\python.exe')).toBe(`& 'C:\\Dev&Test\\python.exe'${pip}`)
    expect(windows("C:\\Bob's\\python.exe")).toBe(`& 'C:\\Bob''s\\python.exe'${pip}`)
  })

  it('creates the venv and installs into it only when creation succeeded', () => {
    expect(venvSetupCommand('/usr/bin/python3', '/my repo', false)).toBe(
      "'/usr/bin/python3' -m venv '/my repo/.venv' && '/my repo/.venv/bin/python' -m pip install -U ipykernel"
    )
    expect(venvSetupCommand('/usr/bin/python3', '/', false)).toBe(
      "'/usr/bin/python3' -m venv '/.venv' && '/.venv/bin/python' -m pip install -U ipykernel"
    )
    expect(venvSetupCommand('C:\\py\\python.exe', 'C:\\repo', true)).toBe(
      "& 'C:\\py\\python.exe' -m venv 'C:\\repo\\.venv'; if ($?) { & 'C:\\repo\\.venv\\Scripts\\python.exe' -m pip install -U ipykernel }"
    )
  })
})
