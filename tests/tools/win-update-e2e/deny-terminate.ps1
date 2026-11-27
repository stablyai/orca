# Denies PROCESS_TERMINATE to Everyone on a process this user owns, so a caller without
# SeDebugPrivilege (the installer) can find it but not end it, like a UAC-elevated process.
# taskkill /F still ends it: it enables SeDebugPrivilege. Prints JSON {ok, error}.
param([Parameter(Mandatory = $true)][int]$TargetPid)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OrcaDenyTerminate {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")]
  static extern uint SetSecurityInfo(IntPtr h, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static string Apply(uint pid) {
    // WRITE_DAC | READ_CONTROL: an owner always holds these.
    IntPtr h = OpenProcess(0x00040000 | 0x00020000, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess " + Marshal.GetLastWin32Error();
    try {
      IntPtr sd; bool present, defaulted; IntPtr dacl;
      // Deny PROCESS_TERMINATE (0x1) to Everyone; allow everything else.
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:(D;;0x1;;;WD)(A;;0x1FFFFF;;;WD)", 1, out sd, IntPtr.Zero))
        return "SDDL " + Marshal.GetLastWin32Error();
      if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted)) return "GetDacl " + Marshal.GetLastWin32Error();
      // SE_KERNEL_OBJECT (6), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION.
      uint rc = SetSecurityInfo(h, 6, 0x4 | 0x80000000, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      return rc == 0 ? null : "SetSecurityInfo " + rc;
    } finally { CloseHandle(h); }
  }
}
'@

$err = [OrcaDenyTerminate]::Apply([uint32]$TargetPid)
[pscustomobject]@{ ok = ($null -eq $err); error = $err } | ConvertTo-Json -Compress
